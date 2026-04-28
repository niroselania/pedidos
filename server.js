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

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const upload = multer({ dest: uploadDir });

app.use(express.json());
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

app.listen(port, () => {
  console.log(`Servidor listo en puerto ${port}`);
});
