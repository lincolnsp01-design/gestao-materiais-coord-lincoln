const express = require("express");
const crypto = require("crypto");
const { Pool } = require("pg");

const app = express();
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("railway") ? { rejectUnauthorized: false } : undefined,
});
const secret = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");

app.use(express.json({ limit: "5mb" }));
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
  `);
  const { rows } = await pool.query("SELECT COUNT(*)::int AS total FROM usuarios");
  if (rows[0].total === 0 && process.env.INITIAL_USERS_JSON) {
    const users = JSON.parse(process.env.INITIAL_USERS_JSON);
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
  const { rows } = await pool.query("SELECT * FROM registros ORDER BY criado_em DESC LIMIT 100");
  res.json(rows);
});

app.post("/api/registros", requireUser, async (req, res) => {
  const { tecnico, materiais, assinatura } = req.body;
  if (!tecnico || !Array.isArray(materiais) || !materiais.length || !assinatura) {
    return res.status(400).json({ error: "Preencha técnico, materiais e assinatura" });
  }
  const { rows } = await pool.query(
    `INSERT INTO registros (tecnico,materiais,assinatura,fornecido_por,fornecedor_login)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [tecnico, JSON.stringify(materiais), assinatura, req.user.nome, req.user.login]
  );
  res.status(201).json(rows[0]);
});

app.use((_req, res) => res.sendFile(require("path").join(__dirname, "public", "index.html")));

initialize()
  .then(() => app.listen(process.env.PORT || 3000))
  .catch(error => {
    console.error(error);
    process.exit(1);
  });
