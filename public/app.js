let tecnicoAtual = null;
const $ = id => document.getElementById(id);

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Não foi possível concluir");
  return data;
}

function adicionarMaterial(valor = "") {
  const linha = document.createElement("div");
  linha.className = "material";
  linha.innerHTML = `<input placeholder="Número do material" value="${valor}"><button type="button">Remover</button>`;
  linha.querySelector("button").onclick = () => linha.remove();
  $("materiais").appendChild(linha);
}

async function carregarHistorico() {
  const registros = await api("/api/registros");
  $("historico").innerHTML = registros.length ? `<table><thead><tr><th>Data</th><th>Técnico</th><th>Materiais</th><th>Fornecido por</th></tr></thead><tbody>${
    registros.map(r => `<tr><td>${new Date(r.criado_em).toLocaleString("pt-BR")}</td><td>${r.tecnico.NOME || r.tecnico.nome || ""}</td><td>${r.materiais.join(", ")}</td><td>${r.fornecido_por}</td></tr>`).join("")
  }</tbody></table>` : "Nenhum fornecimento registrado.";
}

async function iniciar() {
  try {
    const me = await api("/api/me");
    $("login").hidden = true;
    $("painel").hidden = false;
    $("fornecedor").textContent = me.nome;
    if (!$("materiais").children.length) adicionarMaterial();
    await carregarHistorico();
  } catch {}
}

$("login-form").onsubmit = async event => {
  event.preventDefault();
  try {
    const me = await api("/api/login", { method: "POST", body: JSON.stringify({ login: $("usuario").value, senha: $("senha").value }) });
    $("fornecedor").textContent = me.nome;
    $("login").hidden = true;
    $("painel").hidden = false;
    adicionarMaterial();
    await carregarHistorico();
  } catch (error) { $("login-erro").textContent = error.message; }
};

$("pesquisar").onclick = async () => {
  try {
    tecnicoAtual = await api(`/api/tecnicos/${encodeURIComponent($("matricula").value)}`);
    $("tecnico").innerHTML = `<strong>${tecnicoAtual.NOME || tecnicoAtual.nome || "Técnico"}</strong><br>Supervisor: ${tecnicoAtual.SUPERVISOR || tecnicoAtual.supervisor || "-"}<br>Coordenador: ${tecnicoAtual.COORDENADOR || tecnicoAtual.coordenador || "-"}`;
  } catch (error) { $("tecnico").textContent = error.message; }
};

$("adicionar").onclick = () => adicionarMaterial();
$("sair").onclick = async () => { await api("/api/logout", { method: "POST" }); location.reload(); };

const canvas = $("assinatura");
const ctx = canvas.getContext("2d");
let desenhando = false;
function ajustarCanvas() {
  const ratio = devicePixelRatio || 1;
  canvas.width = canvas.clientWidth * ratio;
  canvas.height = canvas.clientHeight * ratio;
  ctx.scale(ratio, ratio);
  ctx.lineWidth = 2.4;
  ctx.lineCap = "round";
}
function ponto(event) {
  const rect = canvas.getBoundingClientRect();
  const touch = event.touches?.[0];
  return { x: (touch?.clientX ?? event.clientX) - rect.left, y: (touch?.clientY ?? event.clientY) - rect.top };
}
canvas.onpointerdown = event => { desenhando = true; const p = ponto(event); ctx.beginPath(); ctx.moveTo(p.x, p.y); };
canvas.onpointermove = event => { if (!desenhando) return; const p = ponto(event); ctx.lineTo(p.x, p.y); ctx.stroke(); };
canvas.onpointerup = canvas.onpointerleave = () => { desenhando = false; };
$("limpar").onclick = () => ctx.clearRect(0, 0, canvas.width, canvas.height);

$("registrar").onclick = async () => {
  try {
    const materiais = [...document.querySelectorAll(".material input")].map(i => i.value.trim()).filter(Boolean);
    if (!tecnicoAtual) throw new Error("Pesquise o técnico primeiro");
    const registro = await api("/api/registros", {
      method: "POST",
      body: JSON.stringify({ tecnico: tecnicoAtual, materiais, assinatura: canvas.toDataURL("image/png") }),
    });
    $("mensagem").textContent = `Registrado em ${new Date(registro.criado_em).toLocaleString("pt-BR")}.`;
    $("materiais").innerHTML = "";
    adicionarMaterial();
    $("limpar").click();
    await carregarHistorico();
  } catch (error) { $("mensagem").textContent = error.message; }
};

addEventListener("resize", ajustarCanvas);
ajustarCanvas();
iniciar();
