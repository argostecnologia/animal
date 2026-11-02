'use strict';
/**
 * Interface pública: escolher foto -> identificar -> resultado OU cadastro.
 * O cadastro só limpa a foto depois da confirmação de gravação pela API.
 * Modelo e versão de pré-processamento devem corresponder às constantes de lib.php.
 */
const $ = id => document.getElementById(id);
const EXTRACTOR = 'mobilenet-js-2.1.1-v2-alpha1';
const PREPROCESS = 'letterbox-512-rgb-v1';
const ESPECIES = ['Cachorro', 'Gato', 'Cavalo', 'Bovino', 'Ovelha', 'Galinha', 'Pato', 'Ganso'];
// Canvas guarda a imagem; Map/Set mantêm as opções de raça sem repetir nomes idênticos.
const canvas = $('quadro'), ctx = canvas.getContext('2d'), video = $('video');
const racas = new Map(ESPECIES.map(e => [e, new Set(['Não identificada', 'Sem raça definida'])]));
let modelo, catalogo = {}, stream = null, fotoPronta = false, ocupado = true;
let cadastroDisponivel = false, csrf = '', features = null, sugestao = null, ultimaEspecie = '';
// Correção reutiliza a foto atual; o servidor protege exemplos anteriores de outros visitantes.
let resultadoAtual = null, corrigindoIdentificacao = false;
// Estados dos dois combos: o foco continua no campo e aria-activedescendant aponta a opção ativa.
const combos = new Map();
// Ignora diferenças de caixa e acentuação somente na pesquisa; preserva o nome apresentado.
function textoNormal(texto) { return texto.normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase(); }
// Converte o texto digitado para uma das oito espécies canônicas, ou retorna null.
function especieValida(texto) { return ESPECIES.find(e => textoNormal(e) === textoNormal(texto)) || null; }
// Mensagem vazia não ocupa espaço na tela inicial.
function status(texto = '') { $('status').textContent = texto; $('status').hidden = !texto; }
// Reconstrói as sugestões com pesquisa por qualquer trecho, usando textContent contra HTML injetado.
function popularLista(id, valores, busca = '') {
  $(id).replaceChildren();
  const estado = combos.get(id);
  if (estado) { estado.ativo = -1; estado.input.removeAttribute('aria-activedescendant'); }
  for (const valor of [...valores].sort((a,b) => a.localeCompare(b, 'pt-BR'))) {
    if (!textoNormal(valor).includes(textoNormal(busca))) continue;
    const option = document.createElement('li');
    option.id = `${id}-opcao-${$(id).children.length}`;
    option.setAttribute('role','option'); option.setAttribute('aria-selected','false');
    option.dataset.valor = valor; option.textContent = valor; $(id).append(option);
  }
  // Parecido não significa igual: ainda oferece Adicionar se só houver correspondências parciais.
  const nomeExato = [...valores].some(valor => textoNormal(valor) === textoNormal(busca));
  if (id === 'lista-racas' && busca.trim() && !nomeExato && especieValida($('especie').value)) {
    const option = document.createElement('li'); option.id = `${id}-opcao-${$(id).children.length}`;
    option.setAttribute('role','option'); option.setAttribute('aria-selected','false');
    option.dataset.valor = busca.trim(); option.dataset.novo = 'true'; option.className = 'combo-adicionar';
    option.textContent = `+ Adicionar nova raça: ${busca.trim()}`; $(id).append(option);
  }
  if (!$(id).children.length) {
    const vazio = document.createElement('li'); vazio.className = 'combo-vazio';
    vazio.textContent = id === 'lista-especies' ? 'Nenhuma espécie encontrada.' : 'Selecione primeiro a espécie.';
    vazio.setAttribute('role','presentation'); $(id).append(vazio);
  }
}
// Coloca a lista acima quando não há espaço embaixo, incluindo o teclado virtual do celular.
function posicionarLista(estado) {
  if (estado.lista.hidden) return;
  const r = estado.input.getBoundingClientRect(), viewport = window.visualViewport;
  const topo = viewport?.offsetTop || 0, altura = viewport?.height || innerHeight;
  const acima = r.top-topo, abaixo = altura+topo-r.bottom;
  const abrirAcima = abaixo < 230 && acima > abaixo;
  estado.lista.classList.toggle('acima',abrirAcima);
  estado.lista.style.maxHeight = `${Math.max(90,Math.min(230,(abrirAcima?acima:abaixo)-16))}px`;
}
function fecharCombos(excecao = null) {
  for (const estado of combos.values()) {
    if (estado === excecao) continue;
    estado.lista.hidden = true; estado.ativo = -1;
    estado.input.setAttribute('aria-expanded','false'); estado.input.removeAttribute('aria-activedescendant');
  }
}
// Clique, toque, setas, Enter, Escape e Tab usam a mesma lista e a mesma seleção.
function configurarCombo(campo, lista, botao, valores) {
  const estado = {input:$(campo),lista:$(lista),botao:$(botao),ativo:-1}; combos.set(lista,estado);
  function abrir(filtrar = false) {
    if (estado.input.disabled) return;
    fecharCombos(estado); popularLista(lista,valores(),filtrar?estado.input.value:'');
    estado.lista.hidden = false; estado.input.setAttribute('aria-expanded','true'); posicionarLista(estado);
  }
  function selecionar(option) {
    if (!option) return;
    estado.input.value = option.dataset.valor;
    estado.input.dispatchEvent(new Event('input',{bubbles:true}));
    fecharCombos(); estado.input.focus({preventScroll:true});
    // focus pode abrir novamente ao escolher por mouse; o valor já foi confirmado.
    fecharCombos();
  }
  estado.input.addEventListener('focus',() => abrir());
  estado.input.addEventListener('click',() => abrir());
  estado.input.addEventListener('input',() => abrir(true));
  estado.botao.onclick = () => {
    const aberto = !estado.lista.hidden; estado.input.focus({preventScroll:true});
    if (aberto) fecharCombos(); else abrir();
  };
  estado.lista.addEventListener('mousedown',evento => evento.preventDefault());
  estado.lista.addEventListener('click',evento => selecionar(evento.target.closest('[role="option"]')));
  estado.input.addEventListener('keydown',evento => {
    if (evento.key === 'Escape') { evento.preventDefault(); fecharCombos(); return; }
    if (evento.key === 'Tab') { fecharCombos(); return; }
    if (evento.key === 'Enter' && !estado.lista.hidden) {
      evento.preventDefault(); const options = estado.lista.querySelectorAll('[role="option"]');
      // Sem navegar nas sugestões, Enter preserva o nome novo em vez de escolher um parecido.
      const novaOpcao = estado.ativo < 0 ? estado.lista.querySelector('[data-novo="true"]') : null;
      selecionar(novaOpcao || options[Math.max(0,estado.ativo)]); return;
    }
    if (!['ArrowDown','ArrowUp'].includes(evento.key)) return;
    evento.preventDefault(); if (estado.lista.hidden) abrir();
    const options = estado.lista.querySelectorAll('[role="option"]'); if (!options.length) return;
    estado.ativo = estado.ativo < 0 ? (evento.key==='ArrowDown'?0:options.length-1)
      : (estado.ativo+(evento.key==='ArrowDown'?1:-1)+options.length)%options.length;
    options.forEach((option,i) => option.setAttribute('aria-selected',String(i===estado.ativo)));
    estado.input.setAttribute('aria-activedescendant',options[estado.ativo].id);
    options[estado.ativo].scrollIntoView({block:'nearest'});
  });
}
// A lista de raças depende da espécie e do filtro que a pessoa está digitando.
function popularRacas() { popularLista('lista-racas', racas.get(especieValida($('especie').value)) || [], $('raca').value); }
// Combina raças do catálogo inicial e do PostgreSQL, respeitando o escopo das espécies.
function incluirRaca(especie, raca) {
  especie = especieValida(especie);
  if (especie && typeof raca === 'string' && raca.trim()) racas.get(especie).add(raca.trim());
}
// Centraliza disponibilidade dos controles; ocupado impede operações simultâneas sobre a mesma foto.
function botoes() {
  const pronto = Boolean(modelo) && !ocupado;
  $('foto').disabled = !pronto; $('camera').disabled = !pronto;
  $('capturar').disabled = !pronto || !stream; $('identificar').disabled = !pronto || !fotoPronta;
  $('outra-foto').disabled = ocupado; $('fechar-camera').disabled = ocupado;
  $('corrigir-identificacao').disabled = !pronto || !fotoPronta || !resultadoAtual;
  $('salvar').disabled = !pronto || !fotoPronta || !cadastroDisponivel;
  $('cancelar-cadastro').disabled = ocupado; $('especie').disabled = ocupado;
  // Raça permanece editável no cadastro/correção, mesmo antes de escolher uma espécie.
  // Só bloqueia durante uma operação em andamento para preservar os dados enviados.
  $('raca').disabled = ocupado;
  $('abrir-especies').disabled = $('especie').disabled; $('abrir-racas').disabled = $('raca').disabled;
}
// A trava sempre é liberada em finally, inclusive em falha de câmera, rede ou banco.
async function executar(tarefa) {
  if (ocupado) return;
  ocupado = true; botoes();
  fecharCombos();
  try { await tarefa(); }
  catch (erro) { console.error(erro); status(erro.message || 'Não foi possível concluir.'); }
  finally { ocupado = false; botoes(); }
}
// GET consulta; POST envia JSON e token CSRF da sessão anônima. Nenhuma credencial do banco vai ao navegador.
async function api(acao, dados) {
  let resposta;
  try {
    resposta = await fetch(`./api.php?action=${acao}`, { credentials:'same-origin', cache:'no-store',
      ...(dados === undefined ? {} : { method:'POST', headers:{'Content-Type':'application/json','X-CSRF-Token':csrf}, body:JSON.stringify(dados) }) });
  } catch { throw new Error('Não foi possível conectar ao servidor.'); }
  let json;
  try { json = await resposta.json(); } catch { throw new Error('O servidor não respondeu corretamente.'); }
  if (!resposta.ok) throw new Error(json.error || 'Não foi possível concluir.');
  return json;
}
// Encerra todas as trilhas para liberar o dispositivo e retirar o indicador de câmera em uso.
function pararCamera() {
  stream?.getTracks().forEach(track => track.stop()); stream = null;
  video.srcObject = null; $('camera-area').hidden = true;
}
// Estado inicial único, reutilizado depois de salvar, cancelar ou escolher outra foto.
function limpar() {
  fecharCombos();
  pararCamera(); fotoPronta = false; features = null; sugestao = null;
  resultadoAtual = null; corrigindoIdentificacao = false; $('corrigir-identificacao').hidden = true;
  ctx.clearRect(0,0,512,512); $('foto').value = '';
  $('preview').hidden = true; $('identificacao').hidden = true; $('cadastro').hidden = true;
  $('selecao-foto').hidden = false; $('resultado').hidden = true; $('resultado').replaceChildren();
  $('cadastro-form').reset(); ultimaEspecie = '';
  $('especie').setCustomValidity(''); popularLista('lista-especies', ESPECIES); popularRacas(); status();
}
// Letterbox preserva o corpo completo, preenchendo as margens sem deformar ou recortar a foto.
function desenhar(origem, largura, altura) {
  fecharCombos();
  if (!largura || !altura) throw new Error('A foto ainda não está pronta.');
  const fator = Math.min(512/largura,512/altura);
  ctx.fillStyle = '#e8eef5'; ctx.fillRect(0,0,512,512);
  ctx.drawImage(origem,(512-largura*fator)/2,(512-altura*fator)/2,largura*fator,altura*fator);
  fotoPronta = true; features = null; sugestao = null;
  resultadoAtual = null; corrigindoIdentificacao = false; $('corrigir-identificacao').hidden = true;
  $('preview').hidden = false; $('identificacao').hidden = false; $('cadastro').hidden = true;
  $('resultado').hidden = true; $('resultado').replaceChildren(); status();
}
// infer(..., true) retorna o embedding. A normalização permite comparar vetores por produto escalar.
// O vetor é reutilizado até a foto mudar e o tensor temporário sempre é liberado.
async function extrair() {
  if (!fotoPronta) throw new Error('Selecione uma foto.');
  if (features) return features;
  const tensor = tf.tidy(() => modelo.infer(canvas,true));
  try {
    const valores = Array.from(await tensor.data()), norma = Math.hypot(...valores);
    if (valores.length !== 1280 || !Number.isFinite(norma) || norma <= 1e-12) throw new Error('Não foi possível analisar esta foto.');
    features = valores.map(v => v/norma); return features;
  } finally { tensor.dispose(); }
}
// Agrupa as classes ImageNet por espécie; várias raças de cachorro contribuem para a mesma espécie.
// Os limiares são heurísticos e não uma avaliação de acurácia ou comprovação de pedigree.
async function sugestaoBase() {
  const saida = tf.tidy(() => tf.softmax(modelo.infer(canvas,false)));
  try {
    const probabilidades = await saida.data();
    const grupos = new Map(ESPECIES.map(e => [e,{especie:e,score:0,raca:'Não identificada',melhorRaca:0}]));
    for (const [id,item] of Object.entries(catalogo)) {
      const grupo = grupos.get(item.especie); if (!grupo) continue;
      const valor = probabilidades[Number(id)] || 0; grupo.score += valor;
      if (valor > grupo.melhorRaca) { grupo.melhorRaca = valor; grupo.raca = item.raca; }
    }
    const classificados = [...grupos.values()].sort((a,b) => b.score-a.score), primeiro = classificados[0];
    if (primeiro.score < 0.55 || primeiro.score-classificados[1].score < 0.15) return null;
    return {especie:primeiro.especie,raca:primeiro.melhorRaca>=0.30 ? primeiro.raca : 'Não identificada',score:primeiro.score};
  } finally { saida.dispose(); }
}
// Campos com miniaturas e números maiores. Similaridade e softmax usam rótulos visuais iguais,
// mas a descrição acessível informa qual pontuação foi usada e que ela não garante acerto.
function mostrarResultado(item, aprendido = false) {
  resultadoAtual = {...item}; $('corrigir-identificacao').hidden = false;
  $('resultado').replaceChildren();
  const animais = {Cachorro:'🐕',Gato:'🐈',Cavalo:'🐎',Bovino:'🐄',Ovelha:'🐑',Galinha:'🐔',Pato:'🦆',Ganso:'🪿'};
  const pontos = Math.max(0,Math.min(100,(aprendido?item.similarity:item.score)*100));
  // Monta cada linha com nós de texto, sem interpretar rótulos cadastrados como HTML.
  function campo(nome,valor,icone,tipo) {
    const linha = document.createElement('div'); linha.className = `resultado-campo ${tipo}`;
    const miniatura = document.createElement('span'); miniatura.className = 'miniatura'; miniatura.textContent = icone; miniatura.setAttribute('aria-hidden','true');
    const dados = document.createElement('div'); dados.className = 'resultado-dados';
    const label = document.createElement('span'); label.className = 'resultado-label'; label.textContent = nome;
    const valorEl = document.createElement('strong'); valorEl.className = 'resultado-valor'; valorEl.textContent = valor;
    dados.append(label,valorEl); linha.append(miniatura,dados); $('resultado').append(linha);
    return dados;
  }
  campo('Espécie',item.especie,animais[item.especie]||'🐾','campo-especie');
  campo('Raça',item.raca||'Não identificada','🏷️','campo-raca');
  const dadosPontuacao = campo('Pontuação',`${pontos.toLocaleString('pt-BR',{minimumFractionDigits:1,maximumFractionDigits:1})}%`,'📊','campo-pontuacao');
  dadosPontuacao.title = `${aprendido?'Similaridade visual':'Pontuação do modelo'}. Não é garantia de acerto.`;
  const barra = document.createElement('div'); barra.className = 'pontuacao-barra'; barra.setAttribute('aria-hidden','true');
  const preenchimento = document.createElement('span'); preenchimento.style.width = `${pontos}%`; barra.append(preenchimento); dadosPontuacao.append(barra);
  $('resultado').hidden = false;
}
// Prefere exemplos confirmados; usa a classificação inicial quando não há correspondência aprendida.
// Erro de consulta não equivale a animal desconhecido: nesse caso mantém Identificação para tentar de novo.
async function identificar() {
  status('Identificando…');
  const vetor = await extrair(), base = await sugestaoBase();
  let aprendido = null, falhaConsulta = false;
  if (cadastroDisponivel) {
    try { aprendido = (await api('predict',{embedding:vetor,extractor:EXTRACTOR,preprocess:PREPROCESS})).match; }
    catch { falhaConsulta = true; }
  }
  if (aprendido && !especieValida(aprendido.especie)) aprendido = null;
  sugestao = {base,learned:aprendido};
  const escolhido = aprendido || base;
  if (escolhido) { mostrarResultado(escolhido,Boolean(aprendido)); status(); return; }
  if (falhaConsulta) { status('Não foi possível consultar os exemplos cadastrados. Tente identificar novamente.'); return; }
  $('identificacao').hidden = true; $('cadastro').hidden = false; $('selecao-foto').hidden = true;
  corrigindoIdentificacao = false; $('cadastro-titulo').textContent = 'Cadastrar animal';
  $('cadastro-orientacao').textContent = 'Animal não reconhecido. Informe os dados para cadastrar.';
  $('salvar').textContent = 'Cadastrar';
  $('cadastro-form').reset(); ultimaEspecie = ''; popularLista('lista-especies',ESPECIES); popularRacas();
  status(cadastroDisponivel ? '' : 'O cadastro está indisponível. Confira a conexão do servidor.');
}
// Aguarda o vídeo definir suas dimensões e o navegador concluir o layout antes de rolar.
// O alvo é o fim dos dois botões, garantindo que Tirar foto e Cancelar caibam na área visível.
async function posicionarCamera() {
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const reduzirMovimento = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  $('camera-controles').scrollIntoView({behavior:reduzirMovimento?'instant':'smooth',block:'end'});
}
// Solicita apenas vídeo e prefere a câmera traseira; falhas também liberam o dispositivo.
$('camera').onclick = () => executar(async () => {
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) throw new Error('A câmera precisa de HTTPS ou localhost. Selecione uma foto como alternativa.');
  limpar();
  try {
    stream = await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'}},audio:false});
    video.srcObject = stream; $('camera-area').hidden = false; await video.play();
    await posicionarCamera();
  } catch (erro) { pararCamera(); throw erro; }
});
// Cancelar volta ao estado sem foto. Capturar apenas prepara a imagem, sem pesquisar automaticamente.
$('fechar-camera').onclick = () => { if (!ocupado) { limpar(); botoes(); } };
$('capturar').onclick = () => executar(async () => {
  if (video.readyState < 2 || !stream?.getVideoTracks().some(t => t.readyState==='live')) throw new Error('A câmera ainda não está pronta.');
  desenhar(video,video.videoWidth,video.videoHeight); pararCamera();
});
// A URL temporária permite decodificar um arquivo local e é revogada até em caso de erro.
$('foto').onchange = () => {
  const arquivo = $('foto').files[0]; if (!arquivo) return;
  executar(async () => {
    const url = URL.createObjectURL(arquivo);
    try { const imagem = new Image(); imagem.src = url; await imagem.decode(); pararCamera(); desenhar(imagem,imagem.naturalWidth,imagem.naturalHeight); }
    finally { URL.revokeObjectURL(url); $('foto').value = ''; }
  });
};
// Eventos de navegação dos cards e limpeza manual.
$('identificar').onclick = () => executar(identificar);
// Abre o outro card com os rótulos sugeridos; a pessoa edita sem precisar enviar a foto de novo.
$('corrigir-identificacao').onclick = () => {
  if (ocupado || !fotoPronta || !resultadoAtual) return;
  fecharCombos(); corrigindoIdentificacao = true;
  $('identificacao').hidden = true; $('cadastro').hidden = false; $('selecao-foto').hidden = true;
  $('cadastro-titulo').textContent = 'Corrigir identificação';
  $('cadastro-orientacao').textContent = 'Confira a espécie e a raça e salve a correção.';
  $('salvar').textContent = 'Salvar correção';
  const especie = especieValida(resultadoAtual.especie) || '';
  $('especie').value = especie; ultimaEspecie = especie;
  $('raca').value = resultadoAtual.raca || 'Não identificada';
  popularLista('lista-especies',ESPECIES); popularRacas(); status(); botoes();
};
$('outra-foto').onclick = $('cancelar-cadastro').onclick = () => { if (!ocupado) { limpar(); botoes(); } };
// Ao trocar uma espécie já definida, descarta a raça anterior; na primeira escolha preserva o texto digitado.
$('especie').oninput = () => {
  const especie = especieValida($('especie').value); $('especie').setCustomValidity('');
  if (especie !== ultimaEspecie) { if (ultimaEspecie) $('raca').value = ''; ultimaEspecie = especie || ''; }
  popularLista('lista-especies',ESPECIES,$('especie').value); popularRacas(); botoes();
};
$('raca').oninput = popularRacas;
// O clique Cadastrar confirma os rótulos. Espécie é restrita; raça nova é aceita e persistida.
// A foto permanece disponível se o envio falhar, permitindo corrigir ou tentar novamente.
$('cadastro-form').onsubmit = evento => {
  evento.preventDefault();
  const especie = especieValida($('especie').value);
  if (!especie) { $('especie').setCustomValidity('Selecione uma das oito espécies da lista.'); $('especie').reportValidity(); return; }
  const raca = $('raca').value.trim() || 'Não identificada';
  executar(async () => {
    if (!cadastroDisponivel) throw new Error('O cadastro está indisponível.');
    status(corrigindoIdentificacao ? 'Salvando correção…' : 'Cadastrando…');
    const resposta = await api('save',{especie,raca,observacoes:'',confirmed:true,correction:corrigindoIdentificacao,image:canvas.toDataURL('image/jpeg',0.88),
      embedding:await extrair(),extractor:EXTRACTOR,preprocess:PREPROCESS,suggestion:sugestao});
    if (!resposta.pending_review) incluirRaca(especie,raca);
    limpar();
    if (resposta.pending_review) status(resposta.message);
  });
};
// Sessão e taxonomia são do servidor; o extrator visual é carregado no navegador.
// Abrir por file:// não executa a API PHP, por isso esse caso recebe orientação específica.
async function iniciar() {
  if (location.protocol==='file:') {
    $('carregamento').hidden = true;
    status('Abra pelo endereço do site: https://erpia.ia.br/animal/index.html.'); ocupado=false; botoes(); return;
  }
  try {
    $('carregamento-etapa').textContent = 'Conectando à base de aprendizado…';
    try { const sessao=await api('session'); csrf=sessao.csrf; cadastroDisponivel=sessao.configured; }
    catch { cadastroDisponivel=false; }
    if (!window.tf || !window.mobilenet) throw new Error('Não foi possível carregar a identificação. Verifique a internet e recarregue.');
    $('carregamento-etapa').textContent = 'Organizando espécies e raças…';
    const resposta=await fetch('./catalogo.json'); if (!resposta.ok) throw new Error('Catálogo indisponível.');
    catalogo=await resposta.json();
    for (const item of Object.values(catalogo)) incluirRaca(item.especie,item.raca);
    if (cadastroDisponivel) {
      try { for (const item of (await api('taxonomy')).labels) incluirRaca(item.especie,item.raca); }
      catch { /* A consulta será tentada novamente ao identificar. */ }
    }
    popularLista('lista-especies',ESPECIES); popularRacas();
    $('carregamento-etapa').textContent = 'Carregando o modelo de identificação…';
    await tf.ready(); modelo=await mobilenet.load({version:2,alpha:1.0}); status();
  } catch (erro) { console.error(erro); status(erro.message); }
  finally {
    $('carregamento').hidden = true; $('selecao-foto').hidden = !modelo;
    $('tentar-novamente').hidden = Boolean(modelo); ocupado=false; botoes();
  }
}
// A lista de raça acompanha a espécie; o campo continua aceitando um nome ainda não cadastrado.
configurarCombo('especie','lista-especies','abrir-especies',() => ESPECIES);
configurarCombo('raca','lista-racas','abrir-racas',() => racas.get(especieValida($('especie').value))||[]);
document.addEventListener('pointerdown',evento => {
  for (const estado of combos.values()) if (estado.input.closest('.combo').contains(evento.target)) return;
  fecharCombos();
});
window.addEventListener('resize',() => combos.forEach(posicionarLista));
window.visualViewport?.addEventListener('resize',() => combos.forEach(posicionarLista));
$('tentar-novamente').onclick = () => location.reload();
// Libera a câmera também quando a pessoa fecha a página ou navega para outro endereço.
window.addEventListener('pagehide',pararCamera);
iniciar();
