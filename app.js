// Ativa regras mais rigorosas do JavaScript, como impedir o uso de variáveis não declaradas.
'use strict';
/**
 * Interface pública: escolher foto -> identificar -> resultado OU cadastro.
 * O cadastro só limpa a foto depois da confirmação de gravação pela API.
 * Modelo e versão de pré-processamento devem corresponder às constantes de lib.php.
 */
// Atalho para buscar um elemento do HTML pelo id. Exemplo: $('foto') busca o campo de foto.
const $ = (id) => document.getElementById(id);
// Identifica o extrator visual usado para gerar os vetores enviados ao servidor.
const EXTRACTOR = 'mobilenet-js-2.1.1-v2-alpha1';
// Identifica como a foto foi preparada: imagem RGB de 512 × 512, com margens para preservar a proporção.
const PREPROCESS = 'letterbox-512-rgb-v1';
// Array com as oito espécies aceitas no formulário e na identificação.
const ESPECIES = ['Cachorro', 'Gato', 'Cavalo', 'Bovino', 'Ovelha', 'Galinha', 'Pato', 'Ganso'];
// Canvas guarda a imagem; Map/Set mantêm as opções de raça sem repetir nomes idênticos.
// canvas é a área do HTML em que a foto será desenhada e analisada.
const canvas = $('quadro'),
  // ctx contém as ferramentas de desenho em duas dimensões do canvas.
  ctx = canvas.getContext('2d'),
  // video é o elemento HTML que exibe a transmissão da câmera.
  video = $('video');
// Map associa cada espécie a um Set de raças. Set evita nomes idênticos repetidos; e representa cada espécie.
const racas = new Map(ESPECIES.map((e) => [e, new Set(['Não identificada', 'Sem raça definida'])]));
// let permite trocar o valor depois. modelo começa como undefined e receberá o modelo de IA carregado.
let modelo,
  // Objeto inicialmente vazio; receberá as classes de animais lidas do arquivo catalogo.json.
  catalogo = {},
  // Guarda a transmissão da câmera. null indica que ainda não existe uma transmissão.
  stream = null,
  // Indica se já existe uma foto desenhada no canvas e pronta para análise.
  fotoPronta = false,
  // Indica uma operação em andamento. Começa como true para bloquear os controles durante a inicialização.
  ocupado = true;
// Indica se o servidor informou que o cadastro está configurado e disponível.
let cadastroDisponivel = false,
  // Token recebido da sessão e enviado nos pedidos POST para proteção contra requisições indevidas.
  csrf = '',
  // Vetor de características visuais da foto; fica guardado para evitar calcular novamente a mesma imagem.
  features = null,
  // Guarda as sugestões do modelo e dos exemplos cadastrados, enviadas junto com o cadastro.
  sugestao = null,
  // Guarda a espécie anterior para decidir quando limpar o campo de raça.
  ultimaEspecie = '';
// Correção reutiliza a foto atual; o servidor protege exemplos anteriores de outros visitantes.
// Guarda uma cópia do último resultado exibido, permitindo abrir o formulário de correção.
let resultadoAtual = null,
  // Indica se o formulário está corrigindo um resultado ou cadastrando um animal não reconhecido.
  corrigindoIdentificacao = false;
// Estados dos dois combos: o foco continua no campo e aria-activedescendant aponta a opção ativa.
// Guarda os elementos e o estado de cada campo com lista de sugestões: espécie e raça.
const combos = new Map();
// Ignora diferenças de caixa e acentuação somente na pesquisa; preserva o nome apresentado.
// Recebe um texto e devolve uma versão sem acentos, espaços nas pontas e letras maiúsculas.
function textoNormal(texto) {
  return texto
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
}
// Converte o texto digitado para uma das oito espécies canônicas, ou retorna null.
// Procura o texto na lista de espécies e devolve o nome oficial encontrado, ou null se não existir.
function especieValida(texto) {
  return ESPECIES.find((e) => textoNormal(e) === textoNormal(texto)) || null;
}
// Mensagem vazia não ocupa espaço na tela inicial.
// Mostra uma mensagem na página; sem argumento, usa texto vazio e esconde a mensagem.
function status(texto = '') {
  $('status').textContent = texto;
  $('status').hidden = !texto;
}
// Reconstrói as sugestões com pesquisa por qualquer trecho, usando textContent contra HTML injetado.
// Monta uma lista de sugestões. id identifica a lista, valores contém as opções e busca é o filtro digitado.
function popularLista(id, valores, busca = '') {
  $(id).replaceChildren();
  // Recupera o estado desse campo: elemento de entrada, lista, botão e índice da opção ativa.
  const estado = combos.get(id);
  if (estado) {
    estado.ativo = -1;
    estado.input.removeAttribute('aria-activedescendant');
  }
  // Copia e ordena as opções em português. valor é a opção atual; a e b são os nomes comparados na ordenação.
  for (const valor of [...valores].sort((a, b) => a.localeCompare(b, 'pt-BR'))) {
    if (!textoNormal(valor).includes(textoNormal(busca))) continue;
    // Cria um item da lista no HTML. option guarda o elemento que receberá o texto e os atributos da opção.
    const option = document.createElement('li');
    option.id = `${id}-opcao-${$(id).children.length}`;
    option.setAttribute('role', 'option');
    option.setAttribute('aria-selected', 'false');
    option.dataset.valor = valor;
    option.textContent = valor;
    $(id).append(option);
  }
  // Parecido não significa igual: ainda oferece Adicionar se só houver correspondências parciais.
  // Booleano que informa se já existe uma opção exatamente igual ao texto pesquisado, ignorando acentos e caixa.
  const nomeExato = [...valores].some((valor) => textoNormal(valor) === textoNormal(busca));
  if (id === 'lista-racas' && busca.trim() && !nomeExato && especieValida($('especie').value)) {
    // Cria um item da lista no HTML. option guarda o elemento que receberá o texto e os atributos da opção.
    const option = document.createElement('li');
    option.id = `${id}-opcao-${$(id).children.length}`;
    option.setAttribute('role', 'option');
    option.setAttribute('aria-selected', 'false');
    option.dataset.valor = busca.trim();
    option.dataset.novo = 'true';
    option.className = 'combo-adicionar';
    option.textContent = `+ Adicionar nova raça: ${busca.trim()}`;
    $(id).append(option);
  }
  if (!$(id).children.length) {
    // Elemento usado para mostrar a mensagem de lista sem opções.
    const vazio = document.createElement('li');
    vazio.className = 'combo-vazio';
    vazio.textContent =
      id === 'lista-especies' ? 'Nenhuma espécie encontrada.' : 'Selecione primeiro a espécie.';
    vazio.setAttribute('role', 'presentation');
    $(id).append(vazio);
  }
}
// Coloca a lista acima quando não há espaço embaixo, incluindo o teclado virtual do celular.
// Calcula o espaço visível ao redor do campo e ajusta a posição e a altura da lista de sugestões.
function posicionarLista(estado) {
  if (estado.lista.hidden) return;
  // r contém a posição e o tamanho do campo na tela.
  const r = estado.input.getBoundingClientRect(),
    // Representa a área visível da página, que pode diminuir quando o teclado do celular aparece.
    viewport = window.visualViewport;
  // Deslocamento do início da área visível; ?. só acessa a propriedade se viewport existir.
  const topo = viewport?.offsetTop || 0,
    // Altura disponível na tela; usa a altura da janela quando visualViewport não está disponível.
    altura = viewport?.height || innerHeight;
  // Quantidade de espaço, em pixels, acima do campo.
  const acima = r.top - topo,
    // Quantidade de espaço, em pixels, abaixo do campo.
    abaixo = altura + topo - r.bottom;
  // Decide abrir acima quando falta espaço abaixo e existe mais espaço acima.
  const abrirAcima = abaixo < 230 && acima > abaixo;
  estado.lista.classList.toggle('acima', abrirAcima);
  estado.lista.style.maxHeight = `${Math.max(90, Math.min(230, (abrirAcima ? acima : abaixo) - 16))}px`;
}
// Fecha todas as listas de sugestões, preservando apenas o estado recebido em excecao, se houver.
function fecharCombos(excecao = null) {
  // Percorre os estados dos campos de espécie e raça; estado representa o campo da vez.
  for (const estado of combos.values()) {
    if (estado === excecao) continue;
    estado.lista.hidden = true;
    estado.ativo = -1;
    estado.input.setAttribute('aria-expanded', 'false');
    estado.input.removeAttribute('aria-activedescendant');
  }
}
// Clique, toque, setas, Enter, Escape e Tab usam a mesma lista e a mesma seleção.
// Configura um campo com sugestões. Recebe os ids dos elementos e uma função valores que fornece as opções atuais.
function configurarCombo(campo, lista, botao, valores) {
  // Agrupa os elementos do campo. ativo é o índice selecionado pelo teclado; -1 significa nenhuma opção ativa.
  const estado = { input: $(campo), lista: $(lista), botao: $(botao), ativo: -1 };
  combos.set(lista, estado);
  // Função interna: abre a lista; se filtrar for true, mostra apenas opções que combinam com o texto digitado.
  function abrir(filtrar = false) {
    if (estado.input.disabled) return;
    fecharCombos(estado);
    popularLista(lista, valores(), filtrar ? estado.input.value : '');
    estado.lista.hidden = false;
    estado.input.setAttribute('aria-expanded', 'true');
    posicionarLista(estado);
  }
  // Função interna: coloca a opção escolhida no campo, dispara o evento input e fecha as sugestões.
  function selecionar(option) {
    if (!option) return;
    estado.input.value = option.dataset.valor;
    estado.input.dispatchEvent(new Event('input', { bubbles: true }));
    fecharCombos();
    estado.input.focus({ preventScroll: true });
    // focus pode abrir novamente ao escolher por mouse; o valor já foi confirmado.
    fecharCombos();
  }
  estado.input.addEventListener('focus', () => abrir());
  estado.input.addEventListener('click', () => abrir());
  estado.input.addEventListener('input', () => abrir(true));
  estado.botao.onclick = () => {
    // Guarda se a lista estava aberta antes de o botão receber o clique.
    const aberto = !estado.lista.hidden;
    estado.input.focus({ preventScroll: true });
    if (aberto) fecharCombos();
    else abrir();
  };
  estado.lista.addEventListener('mousedown', (evento) => evento.preventDefault());
  estado.lista.addEventListener('click', (evento) =>
    selecionar(evento.target.closest('[role="option"]')),
  );
  // evento descreve a tecla pressionada; este trecho trata Escape, Tab, Enter e as setas.
  estado.input.addEventListener('keydown', (evento) => {
    if (evento.key === 'Escape') {
      evento.preventDefault();
      fecharCombos();
      return;
    }
    if (evento.key === 'Tab') {
      fecharCombos();
      return;
    }
    if (evento.key === 'Enter' && !estado.lista.hidden) {
      evento.preventDefault();
      // Coleção das opções disponíveis para escolher ou percorrer pelo teclado.
      const options = estado.lista.querySelectorAll('[role="option"]');
      // Sem navegar nas sugestões, Enter preserva o nome novo em vez de escolher um parecido.
      // Localiza a opção de adicionar uma raça nova quando nenhuma sugestão foi selecionada pelas setas.
      const novaOpcao = estado.ativo < 0 ? estado.lista.querySelector('[data-novo="true"]') : null;
      selecionar(novaOpcao || options[Math.max(0, estado.ativo)]);
      return;
    }
    if (!['ArrowDown', 'ArrowUp'].includes(evento.key)) return;
    evento.preventDefault();
    if (estado.lista.hidden) abrir();
    // Coleção das opções disponíveis para escolher ou percorrer pelo teclado.
    const options = estado.lista.querySelectorAll('[role="option"]');
    if (!options.length) return;
    estado.ativo =
      estado.ativo < 0
        ? evento.key === 'ArrowDown'
          ? 0
          : options.length - 1
        : (estado.ativo + (evento.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
    // Percorre as opções: option é o elemento e i é sua posição; apenas a opção ativa fica marcada.
    options.forEach((option, i) =>
      option.setAttribute('aria-selected', String(i === estado.ativo)),
    );
    estado.input.setAttribute('aria-activedescendant', options[estado.ativo].id);
    options[estado.ativo].scrollIntoView({ block: 'nearest' });
  });
}
// A lista de raças depende da espécie e do filtro que a pessoa está digitando.
// Atualiza as sugestões de raça usando a espécie escolhida e o texto digitado no campo de raça.
function popularRacas() {
  popularLista('lista-racas', racas.get(especieValida($('especie').value)) || [], $('raca').value);
}
// Combina raças do catálogo inicial e do PostgreSQL, respeitando o escopo das espécies.
// Valida a espécie e acrescenta uma raça não vazia ao conjunto dela, sem duplicar nomes idênticos.
function incluirRaca(especie, raca) {
  especie = especieValida(especie);
  if (especie && typeof raca === 'string' && raca.trim()) racas.get(especie).add(raca.trim());
}
// Centraliza disponibilidade dos controles; ocupado impede operações simultâneas sobre a mesma foto.
// Habilita ou desabilita os controles conforme modelo carregado, operação em andamento, foto e cadastro disponível.
function botoes() {
  // true apenas quando o modelo existe e a aplicação está livre para iniciar outra operação.
  const pronto = Boolean(modelo) && !ocupado;
  $('foto').disabled = !pronto;
  $('camera').disabled = !pronto;
  $('capturar').disabled = !pronto || !stream;
  $('identificar').disabled = !pronto || !fotoPronta;
  $('outra-foto').disabled = ocupado;
  $('fechar-camera').disabled = ocupado;
  $('corrigir-identificacao').disabled = !pronto || !fotoPronta || !resultadoAtual;
  $('salvar').disabled = !pronto || !fotoPronta || !cadastroDisponivel;
  $('cancelar-cadastro').disabled = ocupado;
  $('especie').disabled = ocupado;
  // Raça permanece editável no cadastro/correção, mesmo antes de escolher uma espécie.
  // Só bloqueia durante uma operação em andamento para preservar os dados enviados.
  $('raca').disabled = ocupado;
  $('abrir-especies').disabled = $('especie').disabled;
  $('abrir-racas').disabled = $('raca').disabled;
}
// A trava sempre é liberada em finally, inclusive em falha de câmera, rede ou banco.
// Recebe uma função tarefa e aguarda sua conclusão. Bloqueia ações simultâneas, mostra erros e libera os controles no final.
async function executar(tarefa) {
  if (ocupado) return;
  // Indica uma operação em andamento. Começa como true para bloquear os controles durante a inicialização.
  ocupado = true;
  botoes();
  fecharCombos();
  try {
    await tarefa();
  } catch (erro) {
    console.error(erro);
    status(erro.message || 'Não foi possível concluir.');
  } finally {
    ocupado = false;
    botoes();
  }
}
// GET consulta; POST envia JSON e token CSRF da sessão anônima. Nenhuma credencial do banco vai ao navegador.
// Faz uma chamada ao servidor. acao escolhe a operação; dados, quando informado, é convertido em JSON e enviado por POST.
async function api(acao, dados) {
  // Guardará a resposta HTTP do fetch, incluindo o status da requisição.
  let resposta;
  try {
    resposta = await fetch(`./api.php?action=${acao}`, {
      credentials: 'same-origin',
      cache: 'no-store',
      ...(dados === undefined
        ? {}
        : {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
            body: JSON.stringify(dados),
          }),
    });
  } catch {
    throw new Error('Não foi possível conectar ao servidor.');
  }
  // Guardará o conteúdo da resposta convertido de JSON para um valor JavaScript.
  let json;
  try {
    json = await resposta.json();
  } catch {
    throw new Error('O servidor não respondeu corretamente.');
  }
  if (!resposta.ok) throw new Error(json.error || 'Não foi possível concluir.');
  return json;
}
// Encerra todas as trilhas para liberar o dispositivo e retirar o indicador de câmera em uso.
// Para as trilhas da transmissão, retira o vídeo do elemento e esconde a área da câmera.
function pararCamera() {
  // track é cada trilha da transmissão. O acesso opcional evita tentar parar uma câmera inexistente.
  stream?.getTracks().forEach((track) => track.stop());
  stream = null;
  video.srcObject = null;
  $('camera-area').hidden = true;
}
// Estado inicial único, reutilizado depois de salvar, cancelar ou escolher outra foto.
// Reinicia a tela: encerra a câmera, apaga a foto e os resultados, limpa o formulário e redefine as variáveis da imagem.
function limpar() {
  fecharCombos();
  pararCamera();
  fotoPronta = false;
  features = null;
  sugestao = null;
  resultadoAtual = null;
  // Indica se o formulário está corrigindo um resultado ou cadastrando um animal não reconhecido.
  corrigindoIdentificacao = false;
  $('corrigir-identificacao').hidden = true;
  ctx.clearRect(0, 0, 512, 512);
  $('foto').value = '';
  $('preview').hidden = true;
  $('identificacao').hidden = true;
  $('cadastro').hidden = true;
  $('selecao-foto').hidden = false;
  $('resultado').hidden = true;
  $('resultado').replaceChildren();
  $('cadastro-form').reset();
  // Guarda a espécie anterior para decidir quando limpar o campo de raça.
  ultimaEspecie = '';
  $('especie').setCustomValidity('');
  popularLista('lista-especies', ESPECIES);
  popularRacas();
  status();
}
// Letterbox preserva o corpo completo, preenchendo as margens sem deformar ou recortar a foto.
// Recebe uma imagem ou vídeo e suas dimensões; desenha a foto centralizada no canvas e libera a identificação.
function desenhar(origem, largura, altura) {
  fecharCombos();
  if (!largura || !altura) throw new Error('A foto ainda não está pronta.');
  // Escala usada para fazer a foto inteira caber em 512 × 512 pixels, mantendo a proporção original.
  const fator = Math.min(512 / largura, 512 / altura);
  ctx.fillStyle = '#e8eef5';
  ctx.fillRect(0, 0, 512, 512);
  ctx.drawImage(
    origem,
    (512 - largura * fator) / 2,
    (512 - altura * fator) / 2,
    largura * fator,
    altura * fator,
  );
  fotoPronta = true;
  features = null;
  sugestao = null;
  resultadoAtual = null;
  // Indica se o formulário está corrigindo um resultado ou cadastrando um animal não reconhecido.
  corrigindoIdentificacao = false;
  $('corrigir-identificacao').hidden = true;
  $('preview').hidden = false;
  $('identificacao').hidden = false;
  $('cadastro').hidden = true;
  $('resultado').hidden = true;
  $('resultado').replaceChildren();
  status();
}
// infer(..., true) retorna o embedding. A normalização permite comparar vetores por produto escalar.
// O vetor é reutilizado até a foto mudar e o tensor temporário sempre é liberado.
// Gera e devolve o vetor numérico que descreve a foto. Se esse vetor já existir em features, reaproveita o resultado.
async function extrair() {
  if (!fotoPronta) throw new Error('Selecione uma foto.');
  if (features) return features;
  // tensor contém as características extraídas pelo modelo. tf.tidy libera tensores intermediários criados no cálculo.
  const tensor = tf.tidy(() => modelo.infer(canvas, true));
  try {
    // Converte os dados do tensor em um array comum de números; await aguarda os dados ficarem disponíveis.
    const valores = Array.from(await tensor.data()),
      // Comprimento do vetor, usado para normalizá-lo; ... passa cada número do array como argumento.
      norma = Math.hypot(...valores);
    if (valores.length !== 1280 || !Number.isFinite(norma) || norma <= 1e-12)
      throw new Error('Não foi possível analisar esta foto.');
    // v é cada número do vetor. Dividir todos pela norma gera um vetor de comprimento 1 para comparação visual.
    features = valores.map((v) => v / norma);
    return features;
  } finally {
    tensor.dispose();
  }
}
// Agrupa as classes ImageNet por espécie; várias raças de cachorro contribuem para a mesma espécie.
// Os limiares são heurísticos e não uma avaliação de acurácia ou comprovação de pedigree.
// Consulta a classificação do modelo e combina suas classes em espécies; devolve uma sugestão ou null se os limites não forem atingidos.
async function sugestaoBase() {
  // Tensor com as pontuações das classes convertidas por softmax; será liberado no finally.
  const saida = tf.tidy(() => tf.softmax(modelo.infer(canvas, false)));
  try {
    // Array com a pontuação de cada classe prevista pelo modelo.
    const probabilidades = await saida.data();
    // Agrupa pontuações por espécie; cada grupo guarda a soma e a raça com maior pontuação individual.
    const grupos = new Map(
      ESPECIES.map((e) => [e, { especie: e, score: 0, raca: 'Não identificada', melhorRaca: 0 }]),
    );
    // id é o identificador da classe do modelo; item contém a espécie e a raça associadas no catálogo.
    for (const [id, item] of Object.entries(catalogo)) {
      // Recupera o acumulador da espécie correspondente à classe atual.
      const grupo = grupos.get(item.especie);
      if (!grupo) continue;
      // Pontuação da classe atual; usa zero se não houver um valor disponível.
      const valor = probabilidades[Number(id)] || 0;
      grupo.score += valor;
      if (valor > grupo.melhorRaca) {
        grupo.melhorRaca = valor;
        grupo.raca = item.raca;
      }
    }
    // Array de espécies ordenado da maior pontuação para a menor.
    const classificados = [...grupos.values()].sort((a, b) => b.score - a.score),
      // Espécie que recebeu a maior soma de pontuações.
      primeiro = classificados[0];
    // Aceita a espécie apenas com pelo menos 0,55 de pontuação e vantagem de 0,15 sobre a segunda colocada.
    if (primeiro.score < 0.55 || primeiro.score - classificados[1].score < 0.15) return null;
    return {
      especie: primeiro.especie,
      raca: primeiro.melhorRaca >= 0.3 ? primeiro.raca : 'Não identificada',
      score: primeiro.score,
    };
  } finally {
    saida.dispose();
  }
}
// Campos com miniaturas e números maiores. Similaridade e softmax usam rótulos visuais iguais,
// mas a descrição acessível informa qual pontuação foi usada e que ela não garante acerto.
// Mostra espécie, raça e pontuação. item contém os dados; aprendido indica que o resultado veio dos exemplos do servidor.
function mostrarResultado(item, aprendido = false) {
  resultadoAtual = { ...item };
  $('corrigir-identificacao').hidden = false;
  $('resultado').replaceChildren();
  // Objeto que associa o nome de cada espécie ao emoji usado no resultado.
  const animais = {
    Cachorro: '🐕',
    Gato: '🐈',
    Cavalo: '🐎',
    Bovino: '🐄',
    Ovelha: '🐑',
    Galinha: '🐔',
    Pato: '🦆',
    Ganso: '🪿',
  };
  // Converte a similaridade ou pontuação para uma porcentagem limitada ao intervalo de 0 a 100.
  const pontos = Math.max(0, Math.min(100, (aprendido ? item.similarity : item.score) * 100));
  // Monta cada linha com nós de texto, sem interpretar rótulos cadastrados como HTML.
  // Função interna: cria uma linha do resultado com título, conteúdo, ícone e classe CSS; devolve a área dos dados.
  function campo(nome, valor, icone, tipo) {
    // Elemento que agrupa o ícone e os textos de uma linha do resultado.
    const linha = document.createElement('div');
    linha.className = `resultado-campo ${tipo}`;
    // Elemento que exibe o ícone decorativo da linha.
    const miniatura = document.createElement('span');
    miniatura.className = 'miniatura';
    miniatura.textContent = icone;
    miniatura.setAttribute('aria-hidden', 'true');
    // Área que agrupa o título e o valor apresentado.
    const dados = document.createElement('div');
    dados.className = 'resultado-dados';
    // Elemento que mostra o título do campo, como Espécie ou Raça.
    const label = document.createElement('span');
    label.className = 'resultado-label';
    label.textContent = nome;
    // Elemento que mostra o valor em destaque.
    const valorEl = document.createElement('strong');
    valorEl.className = 'resultado-valor';
    valorEl.textContent = valor;
    dados.append(label, valorEl);
    linha.append(miniatura, dados);
    $('resultado').append(linha);
    return dados;
  }
  campo('Espécie', item.especie, animais[item.especie] || '🐾', 'campo-especie');
  campo('Raça', item.raca || 'Não identificada', '🏷️', 'campo-raca');
  // Guarda a área da pontuação para acrescentar a descrição e a barra visual.
  const dadosPontuacao = campo(
    'Pontuação',
    `${pontos.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`,
    '📊',
    'campo-pontuacao',
  );
  dadosPontuacao.title = `${aprendido ? 'Similaridade visual' : 'Pontuação do modelo'}. Não é garantia de acerto.`;
  // Contêiner da barra de pontuação.
  const barra = document.createElement('div');
  barra.className = 'pontuacao-barra';
  barra.setAttribute('aria-hidden', 'true');
  // Parte colorida da barra; sua largura é definida pela porcentagem calculada.
  const preenchimento = document.createElement('span');
  preenchimento.style.width = `${pontos}%`;
  barra.append(preenchimento);
  dadosPontuacao.append(barra);
  $('resultado').hidden = false;
}
// Prefere exemplos confirmados; usa a classificação inicial quando não há correspondência aprendida.
// Erro de consulta não equivale a animal desconhecido: nesse caso mantém Identificação para tentar de novo.
// Analisa a foto, consulta exemplos cadastrados e mostra o resultado; sem reconhecimento, abre o formulário de cadastro.
async function identificar() {
  status('Identificando…');
  // Vetor visual da foto usado para consultar exemplos semelhantes no servidor.
  const vetor = await extrair(),
    // Sugestão calculada pelo modelo no navegador, usada quando não há correspondência aprendida.
    base = await sugestaoBase();
  // Guardará uma correspondência encontrada entre os exemplos cadastrados no servidor.
  let aprendido = null,
    // Registra se a consulta ao servidor falhou, para permitir uma nova tentativa em vez de abrir o cadastro indevidamente.
    falhaConsulta = false;
  if (cadastroDisponivel) {
    try {
      aprendido = (
        await api('predict', { embedding: vetor, extractor: EXTRACTOR, preprocess: PREPROCESS })
      ).match;
    } catch {
      falhaConsulta = true;
    }
  }
  if (aprendido && !especieValida(aprendido.especie)) aprendido = null;
  sugestao = { base, learned: aprendido };
  // Dá preferência ao exemplo cadastrado; se ele não existir, usa a sugestão do modelo.
  const escolhido = aprendido || base;
  if (escolhido) {
    mostrarResultado(escolhido, Boolean(aprendido));
    status();
    return;
  }
  if (falhaConsulta) {
    status('Não foi possível consultar os exemplos cadastrados. Tente identificar novamente.');
    return;
  }
  $('identificacao').hidden = true;
  $('cadastro').hidden = false;
  $('selecao-foto').hidden = true;
  // Indica se o formulário está corrigindo um resultado ou cadastrando um animal não reconhecido.
  corrigindoIdentificacao = false;
  $('cadastro-titulo').textContent = 'Cadastrar animal';
  $('cadastro-orientacao').textContent = 'Animal não reconhecido. Informe os dados para cadastrar.';
  $('salvar').textContent = 'Cadastrar';
  $('cadastro-form').reset();
  // Guarda a espécie anterior para decidir quando limpar o campo de raça.
  ultimaEspecie = '';
  popularLista('lista-especies', ESPECIES);
  popularRacas();
  status(cadastroDisponivel ? '' : 'O cadastro está indisponível. Confira a conexão do servidor.');
}
// Aguarda o vídeo definir suas dimensões e o navegador concluir o layout antes de rolar.
// O alvo é o fim dos dois botões, garantindo que Tirar foto e Cancelar caibam na área visível.
// Aguarda duas atualizações visuais do navegador e rola a página até os controles da câmera.
async function posicionarCamera() {
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  // Indica se a pessoa prefere menos animações; nesse caso, a rolagem será imediata.
  const reduzirMovimento = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  $('camera-controles').scrollIntoView({
    behavior: reduzirMovimento ? 'instant' : 'smooth',
    block: 'end',
  });
}
// Solicita apenas vídeo e prefere a câmera traseira; falhas também liberam o dispositivo.
// Ao clicar em abrir câmera, executa a função anônima abaixo com a proteção de executar.
$('camera').onclick = () =>
  executar(async () => {
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia)
      throw new Error(
        'A câmera precisa de HTTPS ou localhost. Selecione uma foto como alternativa.',
      );
    limpar();
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } },
        audio: false,
      });
      video.srcObject = stream;
      $('camera-area').hidden = false;
      await video.play();
      await posicionarCamera();
    } catch (erro) {
      pararCamera();
      throw erro;
    }
  });
// Cancelar volta ao estado sem foto. Capturar apenas prepara a imagem, sem pesquisar automaticamente.
// Ao cancelar a câmera, limpa a tela e atualiza os botões se nenhuma operação estiver em andamento.
$('fechar-camera').onclick = () => {
  if (!ocupado) {
    limpar();
    botoes();
  }
};
// Ao tirar foto, verifica a câmera, desenha o quadro atual do vídeo e encerra a transmissão.
$('capturar').onclick = () =>
  executar(async () => {
    if (video.readyState < 2 || !stream?.getVideoTracks().some((t) => t.readyState === 'live'))
      throw new Error('A câmera ainda não está pronta.');
    desenhar(video, video.videoWidth, video.videoHeight);
    pararCamera();
  });
// A URL temporária permite decodificar um arquivo local e é revogada até em caso de erro.
// Executa quando a pessoa escolhe um arquivo de imagem no campo de foto.
$('foto').onchange = () => {
  // Primeiro arquivo selecionado; se não houver arquivo, o processamento é encerrado.
  const arquivo = $('foto').files[0];
  if (!arquivo) return;
  executar(async () => {
    // Endereço temporário local para o navegador carregar o arquivo escolhido, sem enviá-lo ao servidor.
    const url = URL.createObjectURL(arquivo);
    try {
      // Objeto de imagem que carregará o arquivo para depois desenhá-lo no canvas.
      const imagem = new Image();
      imagem.src = url;
      await imagem.decode();
      pararCamera();
      desenhar(imagem, imagem.naturalWidth, imagem.naturalHeight);
    } finally {
      URL.revokeObjectURL(url);
      $('foto').value = '';
    }
  });
};
// Eventos de navegação dos cards e limpeza manual.
// Liga o clique do botão Identificar à função identificar, usando o bloqueio de operações simultâneas.
$('identificar').onclick = () => executar(identificar);
// Abre o outro card com os rótulos sugeridos; a pessoa edita sem precisar enviar a foto de novo.
// Abre o formulário de correção preenchido com os dados do resultado atual e mantém a mesma foto.
$('corrigir-identificacao').onclick = () => {
  if (ocupado || !fotoPronta || !resultadoAtual) return;
  fecharCombos();
  corrigindoIdentificacao = true;
  $('identificacao').hidden = true;
  $('cadastro').hidden = false;
  $('selecao-foto').hidden = true;
  $('cadastro-titulo').textContent = 'Corrigir identificação';
  $('cadastro-orientacao').textContent = 'Confira a espécie e a raça e salve a correção.';
  $('salvar').textContent = 'Salvar correção';
  // Nome oficial da espécie do resultado; usa texto vazio quando o nome não é válido.
  const especie = especieValida(resultadoAtual.especie) || '';
  $('especie').value = especie;
  ultimaEspecie = especie;
  $('raca').value = resultadoAtual.raca || 'Não identificada';
  popularLista('lista-especies', ESPECIES);
  popularRacas();
  status();
  botoes();
};
// Os dois botões recebem a mesma função: voltar à tela inicial e limpar a foto quando a aplicação estiver livre.
$('outra-foto').onclick = $('cancelar-cadastro').onclick = () => {
  if (!ocupado) {
    limpar();
    botoes();
  }
};
// Ao trocar uma espécie já definida, descarta a raça anterior; na primeira escolha preserva o texto digitado.
// Executa a cada alteração no campo de espécie para atualizar as raças, a validação e os controles.
$('especie').oninput = () => {
  // Espécie canônica correspondente ao texto do campo, ou null caso o texto ainda não seja válido.
  const especie = especieValida($('especie').value);
  $('especie').setCustomValidity('');
  if (especie !== ultimaEspecie) {
    if (ultimaEspecie) $('raca').value = '';
    ultimaEspecie = especie || '';
  }
  popularLista('lista-especies', ESPECIES, $('especie').value);
  popularRacas();
  botoes();
};
// Atualiza o filtro das sugestões de raça a cada alteração do texto.
$('raca').oninput = popularRacas;
// O clique Cadastrar confirma os rótulos. Espécie é restrita; raça nova é aceita e persistida.
// A foto permanece disponível se o envio falhar, permitindo corrigir ou tentar novamente.
// Trata o envio do formulário. evento.preventDefault impede recarregar a página; os dados serão enviados pela API.
$('cadastro-form').onsubmit = (evento) => {
  evento.preventDefault();
  // Espécie canônica correspondente ao texto do campo, ou null caso o texto ainda não seja válido.
  const especie = especieValida($('especie').value);
  if (!especie) {
    $('especie').setCustomValidity('Selecione uma das oito espécies da lista.');
    $('especie').reportValidity();
    return;
  }
  // Texto da raça sem espaços nas pontas; se estiver vazio, usa Não identificada.
  const raca = $('raca').value.trim() || 'Não identificada';
  executar(async () => {
    if (!cadastroDisponivel) throw new Error('O cadastro está indisponível.');
    status(corrigindoIdentificacao ? 'Salvando correção…' : 'Cadastrando…');
    // Resposta do servidor ao cadastro ou à correção; inclui a indicação de eventual revisão pendente.
    const resposta = await api('save', {
      especie,
      raca,
      observacoes: '',
      confirmed: true,
      correction: corrigindoIdentificacao,
      image: canvas.toDataURL('image/jpeg', 0.88),
      embedding: await extrair(),
      extractor: EXTRACTOR,
      preprocess: PREPROCESS,
      suggestion: sugestao,
    });
    if (!resposta.pending_review) incluirRaca(especie, raca);
    limpar();
    if (resposta.pending_review) status(resposta.message);
  });
};
// Sessão e taxonomia são do servidor; o extrator visual é carregado no navegador.
// Abrir por file:// não executa a API PHP, por isso esse caso recebe orientação específica.
// Prepara a aplicação: abre a sessão, carrega o catálogo, consulta raças cadastradas e carrega o modelo de IA.
async function iniciar() {
  if (location.protocol === 'file:') {
    $('carregamento').hidden = true;
    status('Abra pelo endereço do site: https://erpia.ia.br/animal/index.html.');
    ocupado = false;
    botoes();
    return;
  }
  try {
    $('carregamento-etapa').textContent = 'Conectando à base de aprendizado…';
    try {
      // Dados da sessão retornados pelo servidor, incluindo token CSRF e disponibilidade do cadastro.
      const sessao = await api('session');
      csrf = sessao.csrf;
      cadastroDisponivel = sessao.configured;
    } catch {
      cadastroDisponivel = false;
    }
    if (!window.tf || !window.mobilenet)
      throw new Error(
        'Não foi possível carregar a identificação. Verifique a internet e recarregue.',
      );
    $('carregamento-etapa').textContent = 'Organizando espécies e raças…';
    // Resposta HTTP do arquivo que relaciona classes do modelo às espécies e raças.
    const resposta = await fetch('./catalogo.json');
    if (!resposta.ok) throw new Error('Catálogo indisponível.');
    catalogo = await resposta.json();
    for (const item of Object.values(catalogo)) incluirRaca(item.especie, item.raca);
    if (cadastroDisponivel) {
      try {
        for (const item of (await api('taxonomy')).labels) incluirRaca(item.especie, item.raca);
      } catch {
        /* A consulta será tentada novamente ao identificar. */
      }
    }
    popularLista('lista-especies', ESPECIES);
    popularRacas();
    $('carregamento-etapa').textContent = 'Carregando o modelo de identificação…';
    // Espera o TensorFlow.js ficar pronto antes de carregar o MobileNet.
    await tf.ready();
    // Carrega o MobileNet versão 2 com alpha 1.0 e guarda o modelo para analisar as fotos.
    modelo = await mobilenet.load({ version: 2, alpha: 1.0 });
    status();
  } catch (erro) {
    console.error(erro);
    status(erro.message);
  } finally {
    $('carregamento').hidden = true;
    $('selecao-foto').hidden = !modelo;
    $('tentar-novamente').hidden = Boolean(modelo);
    ocupado = false;
    botoes();
  }
}
// A lista de raça acompanha a espécie; o campo continua aceitando um nome ainda não cadastrado.
configurarCombo('especie', 'lista-especies', 'abrir-especies', () => ESPECIES);
configurarCombo(
  'raca',
  'lista-racas',
  'abrir-racas',
  () => racas.get(especieValida($('especie').value)) || [],
);
// Ao pressionar mouse, caneta ou tela, fecha as sugestões se o toque ocorreu fora dos campos com listas.
document.addEventListener('pointerdown', (evento) => {
  for (const estado of combos.values())
    if (estado.input.closest('.combo').contains(evento.target)) return;
  fecharCombos();
});
// Reposiciona as listas quando o tamanho da janela muda; a função anônima é executada em cada resize.
window.addEventListener('resize', () => combos.forEach(posicionarLista));
// Também reposiciona as listas quando a área visível muda, como ao abrir o teclado do celular.
window.visualViewport?.addEventListener('resize', () => combos.forEach(posicionarLista));
// Recarrega a página ao clicar em Tentar novamente.
$('tentar-novamente').onclick = () => location.reload();
// Libera a câmera também quando a pessoa fecha a página ou navega para outro endereço.
// Registra pararCamera para liberar o dispositivo quando a página deixar de ser exibida.
window.addEventListener('pagehide', pararCamera);
// Chama a função de inicialização assim que este arquivo JavaScript é executado.
iniciar();
