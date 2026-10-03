const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const XLSX = require("xlsx");

const app = express();
const port = Number(process.env.PORT) || 3000;

const dataDir = path.join(__dirname, "data");
const uploadDir = path.join(__dirname, "uploads");
const catalogPath = path.join(dataDir, "catalog.json");
const ordersPath = path.join(dataDir, "orders.json"); // pedidos abiertos
const historyPath = path.join(dataDir, "history.json"); // pedidos cerrados

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const upload = multer({ dest: uploadDir });

app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

function normalizeText(value) {
  return String(value ?? "").trim();
}

function normalizeCode(value) {
  return normalizeText(value).toUpperCase();
}

function normalizeColor(value) {
  return normalizeText(value).toUpperCase();
}

function normalizeSize(value) {
  return normalizeText(value).toUpperCase();
}

function readMinoristaPrice(row) {
  const raw =
    row["PRECIO MINORISTA"] ??
    row.PRECIO_MINORISTA ??
    row.PRECIO ??
    row["PRECIO LISTA"];
  return Number(raw) || 0;
}

function readMayoristaPrice(row) {
  const raw =
    row["PRECIO MAYORISTA"] ??
    row.PRECIO_MAYORISTA ??
    row.PRECIO_MAY;
  return Number(raw) || 0;
}

function readCatalog() {
  if (!fs.existsSync(catalogPath)) return [];
  const raw = fs.readFileSync(catalogPath, "utf8");
  return JSON.parse(raw);
}

function saveCatalog(rows) {
  fs.writeFileSync(catalogPath, JSON.stringify(rows, null, 2), "utf8");
}

app.post("/api/catalog/upload", upload.single("file"), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "Falta adjuntar archivo." });
    }

    const workbook = XLSX.readFile(req.file.path);
    const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(firstSheet, { defval: "" });

    const mapped = rows
      .map((r) => ({
        CODIGO: normalizeCode(r.CODIGO),
        COLOR: normalizeText(r.COLOR),
        TALLE: normalizeText(r.TALLE),
        DESCRIPCION: normalizeText(r.DESCRIPCION),
        PRECIO: readMinoristaPrice(r),
        PRECIO_MAYORISTA: readMayoristaPrice(r)
      }))
      .filter((r) => r.CODIGO);

    saveCatalog(mapped);
    if (fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }

    return res.json({
      ok: true,
      message: "Catalogo cargado correctamente.",
      items: mapped.length
    });
  } catch (error) {
    return res.status(500).json({ error: "No se pudo procesar la planilla." });
  }
});

app.get("/api/product/:codigo", (req, res) => {
  const code = normalizeCode(req.params.codigo);
  const color = normalizeColor(req.query.color);
  const talle = normalizeSize(req.query.talle);
  const catalog = readCatalog();
  let product = null;

  if (color && talle) {
    product = catalog.find(
      (item) =>
        item.CODIGO === code &&
        normalizeColor(item.COLOR) === color &&
        normalizeSize(item.TALLE) === talle
    );
  } else if (color) {
    product = catalog.find(
      (item) => item.CODIGO === code && normalizeColor(item.COLOR) === color
    );
  } else if (talle) {
    product = catalog.find(
      (item) => item.CODIGO === code && normalizeSize(item.TALLE) === talle
    );
  } else {
    product = catalog.find((item) => item.CODIGO === code);
  }

  if (!product) {
    return res.status(404).json({ error: "Producto no encontrado." });
  }

  return res.json(product);
});

app.get("/api/catalog/status", (_req, res) => {
  const catalog = readCatalog();
  return res.json({ loaded: catalog.length > 0, items: catalog.length });
});


// ---------- Pedidos en el servidor ----------
function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file, data) {
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

function cleanItems(items) {
  if (!Array.isArray(items)) return [];
  return items.map((it) => ({
    CODIGO: normalizeText(it.CODIGO),
    COLOR: normalizeText(it.COLOR),
    TALLE: normalizeText(it.TALLE),
    DESCRIPCION: normalizeText(it.DESCRIPCION),
    MAYORISTA: it.MAYORISTA === "SI" ? "SI" : "NO",
    CANTIDAD: Number(it.CANTIDAD) || 0,
    "PRECIO U.": Number(it["PRECIO U."]) || 0,
    TOTAL: Number(it.TOTAL) || 0
  }));
}

// Pedidos abiertos: { "<numero>": { numeroPedido, cliente, items } }
app.get("/api/orders", (_req, res) => {
  res.json(readJson(ordersPath, {}));
});

app.put("/api/orders/:numero", (req, res) => {
  const numero = normalizeText(req.params.numero);
  if (!numero) return res.status(400).json({ error: "Falta numero de pedido." });
  const orders = readJson(ordersPath, {});
  orders[numero] = {
    numeroPedido: numero,
    cliente: normalizeText(req.body.cliente),
    items: cleanItems(req.body.items),
    actualizado: new Date().toISOString()
  };
  writeJsonAtomic(ordersPath, orders);
  res.json({ ok: true });
});

// Cierra el pedido: lo pasa al historial y lo saca de abiertos
app.post("/api/orders/:numero/close", (req, res) => {
  const numero = normalizeText(req.params.numero);
  const orders = readJson(ordersPath, {});
  const cliente = normalizeText(req.body.cliente) || (orders[numero] && orders[numero].cliente) || "";
  const items = cleanItems(req.body.items && req.body.items.length ? req.body.items : orders[numero] && orders[numero].items);
  if (!items.length) return res.status(400).json({ error: "El pedido esta vacio." });

  const history = readJson(historyPath, []);
  history.push({ numeroPedido: numero, cliente, items, cerrado: new Date().toISOString() });
  writeJsonAtomic(historyPath, history);

  delete orders[numero];
  writeJsonAtomic(ordersPath, orders);
  res.json({ ok: true });
});

app.delete("/api/orders/:numero", (req, res) => {
  const numero = normalizeText(req.params.numero);
  const orders = readJson(ordersPath, {});
  delete orders[numero];
  writeJsonAtomic(ordersPath, orders);
  res.json({ ok: true });
});

// Excel acumulado con todos los pedidos cerrados
app.get("/api/history/download", (_req, res) => {
  const history = readJson(historyPath, []);
  const rows = [];
  history.forEach((o) => {
    o.items.forEach((it) => {
      rows.push({
        FECHA: o.cerrado ? o.cerrado.slice(0, 10) : "",
        "N° PEDIDO": o.numeroPedido,
        CLIENTE: o.cliente,
        CODIGO: it.CODIGO,
        COLOR: it.COLOR,
        TALLE: it.TALLE,
        DESCRIPCION: it.DESCRIPCION,
        MAYORISTA: it.MAYORISTA,
        CANTIDAD: it.CANTIDAD,
        "PRECIO U.": it["PRECIO U."],
        TOTAL: it.TOTAL
      });
    });
  });
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Historial");
  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  res.setHeader("Content-Disposition", 'attachment; filename="historial_pedidos.xlsx"');
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.send(buf);
});

app.listen(port, () => {
  console.log(`Servidor listo en puerto ${port}`);
});
