const assert = require('node:assert/strict');
const path = require('node:path');
// Recebe um navegador e banco isolados pelo executor, sem acessar dados da VPS.
module.exports = async ({browser,base,run,pgBin,pgPort,temp}) => {
  const page = await browser.newPage(), erros = [];
  page.on('pageerror', e => erros.push(e.message));
  // Segura apenas o catálogo para observar o carregamento antes de liberar o modelo real.
  let liberarCatalogo;
  const esperaCatalogo = new Promise(resolve => { liberarCatalogo = resolve; });
  await page.route('**/catalogo.json',async route => { await esperaCatalogo; await route.continue(); });
  await page.goto(base,{waitUntil:'domcontentloaded'});
  try {
    assert.equal(await page.locator('#carregamento').isVisible(),true);
    assert.equal(await page.locator('#selecao-foto').isVisible(),false);
    await page.screenshot({path:path.join(temp,'carregamento.png'),fullPage:true});
  } finally { liberarCatalogo(); }
  await page.waitForFunction(() => !document.querySelector('#foto').disabled, null, {timeout:180000});
  await page.unroute('**/catalogo.json');
  assert.equal(await page.locator('#carregamento').isVisible(),false);
  assert.equal(await page.locator('#selecao-foto').isVisible(),true);
  // Invariante do fluxo: sem uma foto, não pode aparecer Identificação nem Cadastro.
  async function nenhumCard() {
    assert.equal(await page.locator('#identificacao').isVisible(),false);
    assert.equal(await page.locator('#cadastro').isVisible(),false);
  }
  await nenhumCard();
  assert.equal(await page.locator('h1').innerText(),'Identificar animal');
  assert.equal(await page.locator('#animal,#amostras,#login-form,dialog').count(),0);
  assert.equal(await page.locator('#lista-especies [role=option]').count(),8);
  await page.screenshot({path:path.join(temp,'inicial.png'),fullPage:true});
  // A câmera apenas fornece a foto: o usuário ainda deve clicar em Identificar.
  const viewportOriginal = page.viewportSize();
  await page.setViewportSize({width:390,height:640});
  await page.locator('#camera').click();
  await page.waitForFunction(() => !document.querySelector('#capturar').disabled);
  // Diferentemente de isVisible, a posição geométrica prova que os botões estão dentro da tela.
  async function controlesNaTela() {
    await page.waitForFunction(() => ['capturar','fechar-camera'].every(id => {
      const r = document.getElementById(id).getBoundingClientRect();
      return r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth;
    }));
  }
  await controlesNaTela();
  await nenhumCard();
  await page.locator('#capturar').click();
  await page.waitForFunction(() => !document.querySelector('#identificar').disabled);
  assert.equal(await page.locator('#identificacao').isVisible(),true);
  assert.equal(await page.locator('#cadastro').isVisible(),false);
  await page.locator('#outra-foto').click(); await nenhumCard();
  // Também cobre uma tela baixa na horizontal e a preferência por movimento reduzido.
  await page.setViewportSize({width:640,height:360});
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.locator('#camera').click();
  await page.waitForFunction(() => !document.querySelector('#capturar').disabled);
  await controlesNaTela();
  await page.locator('#fechar-camera').click(); await nenhumCard();
  await page.setViewportSize(viewportOriginal);
  const imagem = {name:'teste-branco.svg',mimeType:'image/svg+xml',buffer:Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512"><rect width="512" height="512" fill="white"/></svg>')};
  // Fixture sem animal exercita o caminho desconhecido; não é teste de acurácia com fotos reais.
  async function selecionar() {
    await page.locator('#foto').setInputFiles(imagem);
    await page.waitForFunction(() => !document.querySelector('#identificar').disabled);
    assert.equal(await page.locator('#identificacao').isVisible(),true);
    assert.equal(await page.locator('#cadastro').isVisible(),false);
  }
  // Aguarda o fim da operação também quando o card de identificação deixa de ser exibido.
  async function identificar() {
    await page.locator('#identificar').click();
    await page.waitForFunction(() => !document.querySelector('#foto').disabled);
  }
  await selecionar(); await identificar();
  assert.equal(await page.locator('#cadastro').isVisible(),true);
  assert.equal(await page.locator('#raca').isEnabled(),true);
  await page.locator('#raca').fill('Raça digitada antes');
  assert.equal(await page.locator('#identificacao').isVisible(),false);
  await page.locator('#cancelar-cadastro').click(); await nenhumCard();
  await selecionar(); await identificar();
  assert.equal(await page.locator('#cadastro').isVisible(),true);
  // Ao abrir o campo, a lista aparece de verdade; seleção funciona com mouse e teclado.
  await page.locator('#raca').fill('Raça digitada antes');
  await page.locator('#especie').click();
  assert.equal(await page.locator('#lista-especies').isVisible(),true);
  assert.equal(await page.locator('#especie').getAttribute('aria-expanded'),'true');
  await page.getByRole('option',{name:'Gato',exact:true}).click();
  assert.equal(await page.locator('#especie').inputValue(),'Gato');
  assert.equal(await page.locator('#raca').inputValue(),'Raça digitada antes');
  assert.equal(await page.locator('#lista-especies').isVisible(),false);
  await page.locator('#especie').fill('bov');
  assert.equal(await page.locator('#lista-especies [role=option]').count(),1);
  assert.equal(await page.locator('#lista-especies [role=option]').innerText(),'Bovino');
  await page.locator('#especie').press('ArrowDown'); await page.locator('#especie').press('Enter');
  assert.equal(await page.locator('#especie').inputValue(),'Bovino');
  assert.equal(await page.locator('#lista-especies').isVisible(),false);
  await page.locator('#abrir-especies').click();
  assert.equal(await page.locator('#lista-especies [role=option]').count(),8);
  await page.screenshot({path:path.join(temp,'lista-especies.png'),fullPage:true});
  await page.locator('#especie').press('Escape');
  assert.equal(await page.locator('#lista-especies').isVisible(),false);
  // Há sugestão parecida, mas ela não pode impedir o nome novo nem substituir a digitação.
  await page.locator('#raca').fill('Sem raça');
  assert.equal(await page.locator('#lista-racas [role=option]').count(),2);
  assert.match(await page.locator('#lista-racas [data-novo=true]').innerText(),/Adicionar nova raça/);
  await page.locator('#raca').press('Enter');
  assert.equal(await page.locator('#raca').inputValue(),'Sem raça');
  await page.locator('#raca').fill('Nelore de teste'); // Nova opção digitada, sem catálogo prévio.
  assert.match(await page.locator('#lista-racas [role=option]').innerText(),/Adicionar/);
  await page.locator('#raca').press('ArrowDown'); await page.locator('#raca').press('Enter');
  assert.equal(await page.locator('#raca').inputValue(),'Nelore de teste');
  assert.equal(await page.locator('#cadastro').isVisible(),true);
  assert.equal(await page.locator('#lista-racas').isVisible(),false);
  const dados = await page.evaluate(() => ({embedding:features,image:document.querySelector('#quadro').toDataURL('image/jpeg',0.88)}));
  await page.screenshot({path:path.join(temp,'cadastro.png'),fullPage:true});
  await page.locator('#salvar').click();
  // A confirmação do servidor deve acontecer antes de apagar foto, campos e cards.
  await page.waitForFunction(() => !document.querySelector('#foto').disabled && !fotoPronta);
  await nenhumCard();
  assert.equal(await page.locator('#preview').isVisible(),false);
  assert.equal(await page.locator('#especie').inputValue(),'');
  assert.equal(await page.locator('#raca').inputValue(),'');
  assert.equal(await page.evaluate(() => document.querySelector('#quadro').getContext('2d').getImageData(0,0,1,1).data[3]),0);
  const outraSessao = await browser.newContext();
  // Outro visitante pode usar os rótulos públicos, mas não ver ou alterar o acervo anterior.
  const taxonomia = await (await outraSessao.request.get(base+'api.php?action=taxonomy')).json();
  assert.ok(taxonomia.labels.some(l=>l.especie==='Bovino'&&l.raca==='Nelore de teste'));
  const lista = await (await outraSessao.request.get(base+'api.php?action=samples')).json();
  assert.deepEqual(lista.samples,[]);
  assert.equal((await outraSessao.request.get(base+'api.php?action=image&id=1')).status(),403);
  const sessao = await (await outraSessao.request.get(base+'api.php?action=session')).json();
  const headers = {'X-CSRF-Token':sessao.csrf};
  const payload = {...dados,extractor:'mobilenet-js-2.1.1-v2-alpha1',preprocess:'letterbox-512-rgb-v1',especie:'Bovino',raca:'Nelore de teste',confirmed:true};
  // Confirma duplicidade sem deixar um registro AUTO órfão e bloqueia outras espécies na API.
  assert.equal((await outraSessao.request.post(base+'api.php?action=save',{headers,data:payload})).status(),409);
  assert.equal((await outraSessao.request.post(base+'api.php?action=save',{headers,data:{...payload,especie:'Capivara'}})).status(),422);
  assert.equal((await outraSessao.request.post(base+'api.php?action=deactivate',{headers,data:{sample_id:1}})).status(),403);
  const psql = sql => run(path.join(pgBin,'psql.exe'),['-h','127.0.0.1','-p',String(pgPort),'-U','animais_test','-d','postgres','-At','-c',sql]);
  // Verifica a gravação real: uma única referência, dimensão correta e confirmação persistida.
  assert.match(psql('SELECT (SELECT count(*) FROM animal_ia.animais), cardinality(embedding), confirmado FROM animal_ia.amostras'),/1\|1280\|t/);
  // A foto cadastrada agora é reconhecida; Cadastro não aparece junto com Identificação.
  await selecionar(); await identificar();
  assert.equal(await page.locator('#cadastro').isVisible(),false);
  assert.equal(await page.locator('#identificacao').isVisible(),true);
  assert.match(await page.locator('#resultado').innerText(),/Espécie\s+Bovino[\s\S]*Raça\s+Nelore de teste[\s\S]*Pontuação[\s\S]*%/i);
  await page.screenshot({path:path.join(temp,'identificacao.png'),fullPage:true});
  const memoria = await page.evaluate(()=>tf.memory().numTensors);
  // Inferências repetidas não devem acumular tensores temporários na GPU/memória.
  await identificar(); await identificar();
  assert.equal(await page.evaluate(()=>tf.memory().numTensors),memoria);
  await page.locator('#outra-foto').click(); await nenhumCard();
  await page.reload();
  // O reconhecimento persiste em outra abertura da página, independentemente do estado da interface.
  await page.waitForFunction(()=>!document.querySelector('#foto').disabled,null,{timeout:180000});
  await nenhumCard();
  await selecionar(); await identificar();
  assert.match(await page.locator('#resultado').innerText(),/Espécie\s+Bovino/i);
  // A correção de foto alheia é registrada para revisão e não substitui seu exemplo anterior.
  const sugestaoAlheia = await (await outraSessao.request.post(base+'api.php?action=save',{
    headers,data:{...payload,correction:true,especie:'Gato',raca:'Siamês'}
  })).json();
  assert.equal(sugestaoAlheia.pending_review,true);
  const aposSugestao = await (await outraSessao.request.post(base+'api.php?action=predict',{headers,data:payload})).json();
  assert.equal(aposSugestao.match.especie,'Bovino');
  // O botão reutiliza foto e dados, habilita raça e permite corrigir o próprio envio sem duplicar a imagem.
  assert.equal(await page.locator('#corrigir-identificacao').isVisible(),true);
  await page.locator('#corrigir-identificacao').click();
  assert.equal(await page.locator('#identificacao').isVisible(),false);
  assert.equal(await page.locator('#cadastro').isVisible(),true);
  assert.equal(await page.locator('#especie').inputValue(),'Bovino');
  assert.equal(await page.locator('#raca').inputValue(),'Nelore de teste');
  assert.equal(await page.locator('#raca').isEnabled(),true);
  await page.locator('#especie').fill('Cavalo');
  await page.locator('#raca').fill('Mangalarga de teste');
  await page.locator('#raca').press('Enter');
  await page.locator('#salvar').click();
  await page.waitForFunction(()=>!document.querySelector('#foto').disabled && !fotoPronta);
  await nenhumCard();
  await selecionar(); await identificar();
  assert.match(await page.locator('#resultado').innerText(),/Espécie\s+Cavalo[\s\S]*Raça\s+Mangalarga de teste/i);
  assert.match(psql('SELECT count(*) FROM animal_ia.amostras'),/^1/);
  assert.match(psql("SELECT count(*) FROM animal_ia.revisoes WHERE depois->>'estado' = 'aplicada'"),/^1/);
  assert.deepEqual(erros,[]);
  await outraSessao.close();
  console.log('OK: carregamento visual, listas visíveis, pesquisa, mouse e teclado, câmera responsiva, cards alternados, raça persistida, limpeza, reconhecimento e acervo protegido.');
};
