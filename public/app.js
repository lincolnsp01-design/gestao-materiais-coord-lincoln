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
  $("historico").innerHTML = registros.length ? `<div class="tabela-scroll"><table><thead><tr><th>Data</th><th>Técnico</th><th>Materiais</th><th>Fornecido por</th><th>Comprovante</th></tr></thead><tbody>${
    registros.map(r => `<tr><td>${new Date(r.criado_em).toLocaleString("pt-BR")}</td><td>${r.tecnico.NOME || r.tecnico.nome || ""}</td><td>${r.materiais.join(", ")}</td><td>${r.fornecido_por}</td><td><a class="exportar-pdf" href="/api/registros/${r.id}/pdf" target="_blank">Exportar PDF</a></td></tr>`).join("")
  }</tbody></table></div>` : "Nenhum fornecimento registrado.";
}

async function iniciar() {
  try {
    const me = await api("/api/me");
    $("login").hidden = true;
    $("painel").hidden = false;
    $("fornecedor").textContent = me.nome;
    requestAnimationFrame(ajustarCanvas);
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
    requestAnimationFrame(ajustarCanvas);
    adicionarMaterial();
    await carregarHistorico();
  } catch (error) { $("login-erro").textContent = error.message; }
};

$("pesquisar").onclick = async () => {
  try {
    tecnicoAtual = await api(`/api/tecnicos/${encodeURIComponent($("matricula").value)}`);
    $("tecnico").innerHTML = `<strong>${tecnicoAtual.NOME || tecnicoAtual.nome || "Técnico"}</strong><br>Supervisor: ${tecnicoAtual.SUPERVISOR || tecnicoAtual.supervisor || "-"}<br>Coordenador: ${tecnicoAtual.COORDENADOR || tecnicoAtual.coordenador || "-"}`;
    $("nome-assinante").textContent = tecnicoAtual.NOME || tecnicoAtual.nome || "Técnico";
  } catch (error) { $("tecnico").textContent = error.message; }
};

$("adicionar").onclick = () => adicionarMaterial();
$("sair").onclick = async () => { await api("/api/logout", { method: "POST" }); location.reload(); };

const canvas = $("assinatura");
const ctx = canvas.getContext("2d");
let desenhando = false;
let assinaturaFeita = false;
function ajustarCanvas() {
  if (!canvas.clientWidth || !canvas.clientHeight) return;
  const ratio = devicePixelRatio || 1;
  const largura = Math.round(canvas.clientWidth * ratio);
  const altura = Math.round(canvas.clientHeight * ratio);
  if (canvas.width === largura && canvas.height === altura) return;
  canvas.width = largura;
  canvas.height = altura;
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.lineWidth = 2.4;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = "#17211a";
}
function ponto(event) {
  const rect = canvas.getBoundingClientRect();
  const touch = event.touches?.[0];
  return { x: (touch?.clientX ?? event.clientX) - rect.left, y: (touch?.clientY ?? event.clientY) - rect.top };
}
canvas.onpointerdown = event => {
  event.preventDefault();
  canvas.setPointerCapture?.(event.pointerId);
  desenhando = true;
  assinaturaFeita = true;
  $("dica-assinatura").hidden = true;
  const p = ponto(event);
  ctx.beginPath();
  ctx.moveTo(p.x, p.y);
  ctx.lineTo(p.x + 0.1, p.y + 0.1);
  ctx.stroke();
};
canvas.onpointermove = event => {
  if (!desenhando) return;
  event.preventDefault();
  const p = ponto(event);
  ctx.lineTo(p.x, p.y);
  ctx.stroke();
};
canvas.onpointerup = canvas.onpointercancel = event => {
  desenhando = false;
  if (event.pointerId !== undefined && canvas.hasPointerCapture?.(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
};
$("limpar").onclick = () => {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  assinaturaFeita = false;
  $("dica-assinatura").hidden = false;
};

let fotoData = "";
async function prepararFoto(arquivo) {
  const url = URL.createObjectURL(arquivo);
  const imagem = new Image();
  await new Promise((resolve, reject) => {
    imagem.onload = resolve;
    imagem.onerror = reject;
    imagem.src = url;
  });
  const maximo = 1400;
  const escala = Math.min(1, maximo / Math.max(imagem.width, imagem.height));
  const redutor = document.createElement("canvas");
  redutor.width = Math.round(imagem.width * escala);
  redutor.height = Math.round(imagem.height * escala);
  redutor.getContext("2d").drawImage(imagem, 0, 0, redutor.width, redutor.height);
  fotoData = redutor.toDataURL("image/jpeg", 0.78);
  URL.revokeObjectURL(url);
  $("foto-preview").src = fotoData;
  $("foto-preview-area").hidden = false;
}

$("foto").onchange = async event => {
  const arquivo = event.target.files?.[0];
  if (!arquivo) return;
  try {
    await prepararFoto(arquivo);
    $("mensagem").textContent = "Foto registrada com sucesso.";
  } catch {
    $("mensagem").textContent = "Não foi possível processar a foto. Tente novamente.";
  }
};

$("trocar-foto").onclick = () => $("foto").click();

$("registrar").onclick = async () => {
  try {
    const materiais = [...document.querySelectorAll(".material input")].map(i => i.value.trim()).filter(Boolean);
    if (!tecnicoAtual) throw new Error("Pesquise o técnico primeiro");
    if (!fotoData) throw new Error("Registre a foto dos equipamentos + crachá do técnico");
    if (!assinaturaFeita) throw new Error("Peça ao técnico para assinar no quadro");
    const registro = await api("/api/registros", {
      method: "POST",
      body: JSON.stringify({ tecnico: tecnicoAtual, materiais, foto: fotoData, assinatura: canvas.toDataURL("image/png") }),
    });
    $("mensagem").textContent = `Registrado em ${new Date(registro.criado_em).toLocaleString("pt-BR")}.`;
    $("materiais").innerHTML = "";
    adicionarMaterial();
    $("limpar").click();
    fotoData = "";
    $("foto").value = "";
    $("foto-preview").removeAttribute("src");
    $("foto-preview-area").hidden = true;
    await carregarHistorico();
  } catch (error) { $("mensagem").textContent = error.message; }
};

addEventListener("resize", ajustarCanvas);
iniciar();
