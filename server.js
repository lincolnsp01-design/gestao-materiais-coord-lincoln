const express = require("express");
const crypto = require("crypto");
const { Pool } = require("pg");
const PDFDocument = require("pdfkit");
const ExcelJS = require("exceljs");

const app = express();
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("railway") ? { rejectUnauthorized: false } : undefined,
});
const secret = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");

app.use(express.json({ limit: "12mb" }));
app.use(express.static("public"));

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, expected] = stored.split(":");
  if (!salt || !expected) return false;
  const actual = crypto.scryptSync(password, salt, 64);
  return crypto.timingSafeEqual(actual, Buffer.from(expected, "hex"));
}

function sign(value) {
  return crypto.createHmac("sha256", secret).update(value).digest("hex");
}

function sessionFor(user) {
  const payload = Buffer.from(JSON.stringify({
    id: user.id,
    nome: user.nome,
    login: user.login,
    exp: Date.now() + 12 * 60 * 60 * 1000,
  })).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

function readSession(req) {
  const token = (req.headers.cookie || "").split(";").map(v => v.trim())
    .find(v => v.startsWith("session="))?.slice(8);
  if (!token) return null;
  const [payload, signature] = token.split(".");
  if (!payload || !signature || sign(payload) !== signature) return null;
  const data = JSON.parse(Buffer.from(payload, "base64url").toString());
  return data.exp > Date.now() ? data : null;
}

function requireUser(req, res, next) {
  const user = readSession(req);
  if (!user) return res.status(401).json({ error: "Acesso não autorizado" });
  req.user = user;
  next();
}

async function initialize() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS usuarios (
      id SERIAL PRIMARY KEY,
      nome TEXT NOT NULL,
      login TEXT UNIQUE NOT NULL,
      senha_hash TEXT NOT NULL,
      ativo BOOLEAN NOT NULL DEFAULT TRUE
    );
    CREATE TABLE IF NOT EXISTS registros (
      id SERIAL PRIMARY KEY,
      tecnico JSONB NOT NULL,
      materiais JSONB NOT NULL,
      assinatura TEXT NOT NULL,
      fornecido_por TEXT NOT NULL,
      fornecedor_login TEXT NOT NULL,
      criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS tecnicos (
      matricula TEXT PRIMARY KEY,
      nome TEXT NOT NULL,
      supervisor TEXT,
      coordenador TEXT,
      status TEXT
    );
    ALTER TABLE registros ADD COLUMN IF NOT EXISTS foto TEXT;
  `);
  const { rows } = await pool.query("SELECT COUNT(*)::int AS total FROM usuarios");
  if (rows[0].total === 0 && process.env.INITIAL_USERS_JSON) {
    const rawUsers = process.env.INITIAL_USERS_JSON.trim();
    const start = rawUsers.indexOf("[");
    const end = rawUsers.lastIndexOf("]");
    const users = JSON.parse(start >= 0 && end > start ? rawUsers.slice(start, end + 1) : rawUsers);
    for (const user of users) {
      await pool.query(
        "INSERT INTO usuarios (nome, login, senha_hash) VALUES ($1,$2,$3) ON CONFLICT (login) DO NOTHING",
        [user.nome, user.login.toUpperCase(), hashPassword(String(user.senha))]
      );
    }
  }
}

app.post("/api/login", async (req, res) => {
  const login = String(req.body.login || "").trim().toUpperCase();
  const senha = String(req.body.senha || "");
  const { rows } = await pool.query(
    "SELECT id,nome,login,senha_hash FROM usuarios WHERE login=$1 AND ativo=TRUE",
    [login]
  );
  const user = rows[0];
  if (!user || !verifyPassword(senha, user.senha_hash)) {
    return res.status(401).json({ error: "Login ou senha inválidos" });
  }
  res.setHeader("Set-Cookie", `session=${sessionFor(user)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=43200`);
  res.json({ nome: user.nome, login: user.login });
});

app.post("/api/logout", (_req, res) => {
  res.setHeader("Set-Cookie", "session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0");
  res.json({ ok: true });
});

app.get("/api/me", requireUser, (req, res) => res.json(req.user));

app.get("/api/tecnicos/:matricula", requireUser, (req, res) => {
  const matricula = String(req.params.matricula).trim().toUpperCase();
  pool.query("SELECT * FROM tecnicos WHERE UPPER(matricula)=$1", [matricula])
    .then(({ rows }) => rows[0]
      ? res.json(rows[0])
      : res.status(404).json({ error: "Técnico não encontrado" }))
    .catch(() => res.status(500).json({ error: "Não foi possível pesquisar o técnico" }));
});

app.post("/api/admin/importar-tecnicos", requireUser, async (req, res) => {
  if (req.user.login !== "RIBEIRO01") {
    return res.status(401).json({ error: "Importação não autorizada" });
  }
  const tecnicos = Array.isArray(req.body) ? req.body : [];
  if (!tecnicos.length || tecnicos.length > 10000) {
    return res.status(400).json({ error: "Cadastro inválido" });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "DELETE FROM tecnicos WHERE UPPER(coordenador)=UPPER($1)",
      ["LINCOLN RIBEIRO DO NASCIMENTO"]
    );
    for (const tecnico of tecnicos) {
      await client.query(
        `INSERT INTO tecnicos (matricula,nome,supervisor,coordenador,status)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (matricula) DO UPDATE SET
           nome=EXCLUDED.nome, supervisor=EXCLUDED.supervisor,
           coordenador=EXCLUDED.coordenador, status=EXCLUDED.status`,
        [
          String(tecnico.matricula || tecnico.MATR_SAP || "").trim(),
          String(tecnico.nome || tecnico.NOME || "").trim(),
          tecnico.supervisor || tecnico.SUPERVISOR || null,
          tecnico.coordenador || tecnico.COORDENADOR || null,
          tecnico.status || tecnico.STATUS || null,
        ]
      );
    }
    await client.query("COMMIT");
    res.json({ importados: tecnicos.length });
  } catch (error) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: "Falha ao importar técnicos" });
  } finally {
    client.release();
  }
});

app.get("/api/registros", requireUser, async (_req, res) => {
  const { rows } = await pool.query(
    "SELECT id,tecnico,materiais,fornecido_por,fornecedor_login,criado_em,(foto IS NOT NULL) AS tem_foto FROM registros ORDER BY criado_em DESC LIMIT 100"
  );
  res.json(rows);
});

app.get("/api/registros-exportar/excel", requireUser, async (_req, res) => {
  const { rows } = await pool.query("SELECT * FROM registros ORDER BY criado_em DESC");
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Controle de Materiais - Coord Lincoln";
  workbook.created = new Date();
  const sheet = workbook.addWorksheet("Fornecimentos", {
    views: [{ state: "frozen", ySplit: 1 }],
    properties: { defaultRowHeight: 20 },
  });
  sheet.columns = [
    { header: "DATA E HORÁRIO", key: "data", width: 23 },
    { header: "NOME DO TÉCNICO", key: "nome", width: 38 },
    { header: "MATRÍCULA SAP", key: "matricula", width: 18 },
    { header: "NÚMERO DO MATERIAL", key: "material", width: 25 },
    { header: "SUPERVISOR", key: "supervisor", width: 38 },
    { header: "COORDENADOR", key: "coordenador", width: 38 },
    { header: "FORNECIDO POR", key: "fornecidoPor", width: 38 },
  ];
  for (const registro of rows) {
    const tecnico = registro.tecnico || {};
    for (const material of registro.materiais || []) {
      sheet.addRow({
        data: new Date(registro.criado_em).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" }),
        nome: tecnico.nome || tecnico.NOME || "",
        matricula: tecnico.matricula || tecnico.MATR_SAP || "",
        material,
        supervisor: tecnico.supervisor || tecnico.SUPERVISOR || "",
        coordenador: tecnico.coordenador || tecnico.COORDENADOR || "",
        fornecidoPor: registro.fornecido_por,
      });
    }
  }
  sheet.getRow(1).eachCell(cell => {
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF176B3C" } };
    cell.alignment = { vertical: "middle", horizontal: "center" };
  });
  sheet.autoFilter = { from: "A1", to: "G1" };
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber > 1 && rowNumber % 2 === 0) {
      row.eachCell(cell => {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEAF4ED" } };
      });
    }
  });
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="historico-fornecimentos-${new Date().toISOString().slice(0, 10)}.xlsx"`);
  await workbook.xlsx.write(res);
  res.end();
});

app.post("/api/registros", requireUser, async (req, res) => {
  const { tecnico, materiais, assinatura, foto } = req.body;
  if (!tecnico || !Array.isArray(materiais) || !materiais.length || !assinatura || !foto) {
    return res.status(400).json({ error: "Preencha técnico, materiais, foto e assinatura" });
  }
  const { rows } = await pool.query(
    `INSERT INTO registros (tecnico,materiais,assinatura,foto,fornecido_por,fornecedor_login)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id,tecnico,materiais,fornecido_por,criado_em`,
    [tecnico, JSON.stringify(materiais), assinatura, foto, req.user.nome, req.user.login]
  );
  res.status(201).json(rows[0]);
});

function dataUrlBuffer(value) {
  const match = String(value || "").match(/^data:image\/(?:png|jpeg|jpg);base64,(.+)$/);
  return match ? Buffer.from(match[1], "base64") : null;
}

app.get("/api/registros/:id/pdf", requireUser, async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM registros WHERE id=$1", [req.params.id]);
  const registro = rows[0];
  if (!registro) return res.status(404).json({ error: "Registro não encontrado" });

  const tecnico = registro.tecnico || {};
  const nome = tecnico.nome || tecnico.NOME || "Técnico";
  const matricula = tecnico.matricula || tecnico.MATR_SAP || "-";
  const supervisor = tecnico.supervisor || tecnico.SUPERVISOR || "-";
  const coordenador = tecnico.coordenador || tecnico.COORDENADOR || "-";
  const foto = dataUrlBuffer(registro.foto);
  const assinatura = dataUrlBuffer(registro.assinatura);

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="fornecimento-${registro.id}.pdf"`);
  const doc = new PDFDocument({ size: "A4", margin: 45, info: { Title: `Comprovante de fornecimento ${registro.id}` } });
  doc.pipe(res);
  doc.rect(0, 0, 595, 105).fill("#092e25");
  doc.fillColor("#43ef99").fontSize(25).font("Helvetica-Bold").text("BH", 45, 30);
  doc.fillColor("#ffffff").fontSize(17).text("CONTROLE DE MATERIAIS", 100, 28);
  doc.fillColor("#a8d9c0").fontSize(9).font("Helvetica").text("GESTÃO COORDENADOR LINCOLN • BELO HORIZONTE", 100, 55);
  doc.fillColor("#173529").fontSize(15).font("Helvetica-Bold").text("COMPROVANTE DE FORNECIMENTO", 45, 130);
  doc.fontSize(10).font("Helvetica");
  doc.text(`Registro: ${registro.id}`, 45, 160);
  doc.text(`Data e horário: ${new Date(registro.criado_em).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })}`, 45, 178);
  doc.text(`Fornecido por: ${registro.fornecido_por}`, 45, 196);
  doc.moveTo(45, 222).lineTo(550, 222).strokeColor("#c9d8cf").stroke();
  doc.font("Helvetica-Bold").text("TÉCNICO RECEBEDOR", 45, 238);
  doc.font("Helvetica").text(`Nome: ${nome}`, 45, 258);
  doc.text(`Matrícula SAP: ${matricula}`, 45, 276);
  doc.text(`Supervisor: ${supervisor}`, 45, 294);
  doc.text(`Coordenador: ${coordenador}`, 45, 312);
  doc.font("Helvetica-Bold").text("MATERIAIS FORNECIDOS", 45, 342);
  doc.font("Helvetica");
  (registro.materiais || []).forEach((material, index) => doc.text(`${index + 1}. ${material}`, 55, 362 + index * 16));
  const conteudoY = Math.max(420, 378 + (registro.materiais || []).length * 16);
  if (foto) {
    doc.font("Helvetica-Bold").text("FOTO DOS EQUIPAMENTOS + CRACHÁ", 45, conteudoY);
    try { doc.image(foto, 45, conteudoY + 20, { fit: [315, 210], align: "left", valign: "center" }); } catch {}
  }
  if (assinatura) {
    doc.font("Helvetica-Bold").text("ASSINATURA DO TÉCNICO", 385, conteudoY);
    try { doc.image(assinatura, 385, conteudoY + 20, { fit: [165, 100], align: "center", valign: "center" }); } catch {}
    doc.moveTo(385, conteudoY + 125).lineTo(550, conteudoY + 125).strokeColor("#708379").stroke();
    doc.fontSize(8).font("Helvetica").text(nome, 385, conteudoY + 130, { width: 165, align: "center" });
  }
  doc.fontSize(8).fillColor("#668077").text("Documento gerado pelo Controle de Materiais — Belo Horizonte", 45, 805, { width: 505, align: "center" });
  doc.end();
});

app.use((_req, res) => res.sendFile(require("path").join(__dirname, "public", "index.html")));

initialize()
  .then(() => app.listen(3000, "0.0.0.0"))
  .catch(error => {
    console.error(error);
    process.exit(1);
  });
