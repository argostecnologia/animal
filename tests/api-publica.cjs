// Regressão HTTP das rotas públicas; usa arquivos e sessões temporários e não acessa o PostgreSQL.
// Executar: PHP_BIN=caminho/do/php node tests/api-publica.cjs (defina a variável conforme seu terminal).
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const php = process.env.PHP_BIN || 'php';
const raiz = path.resolve(__dirname, '..');

async function portaLivre() {
  const servidor = net.createServer();
  await new Promise(resolve => servidor.listen(0, '127.0.0.1', resolve));
  const porta = servidor.address().port;
  await new Promise(resolve => servidor.close(resolve));
  return porta;
}

(async () => {
  const temporario = fs.mkdtempSync(path.join(os.tmpdir(), 'animais-api-publica-'));
  const sessoes = path.join(temporario, 'sessions');
  fs.mkdirSync(sessoes);
  for (const arquivo of ['api.php', 'lib.php']) {
    fs.copyFileSync(path.join(raiz, arquivo), path.join(temporario, arquivo));
  }
  // Simula uma sessão criada pela versão antiga, para provar que ela não reativa rotas removidas.
  fs.writeFileSync(path.join(temporario, 'sessao-antiga.php'), `<?php
session_name('ANIMAIS_IA_SESSION');
session_start();
$_SESSION['admin'] = true;
$_SESSION['amostras_enviadas'] = [1, 2];
echo '{}';
`);
  const porta = await portaLivre();
  const log = fs.openSync(path.join(temporario, 'php.log'), 'a');
  const servidor = spawn(php, [
    '-d', `session.save_path="${sessoes.replaceAll('\\', '/')}"`,
    '-S', `127.0.0.1:${porta}`, '-t', temporario,
  ], {
    windowsHide: true,
    env: { ...process.env, ANIMAIS_CONFIG_FILE: path.join(temporario, 'config-ausente.php') },
    stdio: ['ignore', log, log],
  });
  let falhaInicio;
  servidor.on('error', erro => { falhaInicio = erro; });
  let cookie = '', csrf = '', verificacoes = 0;
  async function requisitar(acao, status, metodo = 'GET', corpo, token = true) {
    const resposta = await fetch(`http://127.0.0.1:${porta}/api.php?action=${acao}`, {
      method: metodo,
      headers: {
        Cookie: cookie,
        ...(corpo === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(token && csrf ? { 'X-CSRF-Token': csrf } : {}),
      },
      ...(corpo === undefined ? {} : { body: corpo }),
    });
    assert.equal(resposta.status, status, `${metodo} ${acao}`);
    assert.match(resposta.headers.get('content-type'), /application\/json/);
    const novoCookie = resposta.headers.get('set-cookie');
    if (novoCookie) cookie = novoCookie.split(';')[0];
    const dados = await resposta.json();
    if (dados.csrf) csrf = dados.csrf;
    verificacoes++;
    return dados;
  }
  function conferirSessao(dados) {
    assert.deepEqual(Object.keys(dados).sort(), ['configured', 'csrf']);
    assert.equal(dados.configured, false);
    assert.match(dados.csrf, /^[0-9a-f]{64}$/);
  }
  try {
    let pronto = false;
    for (let tentativa = 0; tentativa < 60; tentativa++) {
      if (falhaInicio) throw falhaInicio;
      try { await fetch(`http://127.0.0.1:${porta}/api.php`); pronto = true; break; }
      catch { await new Promise(resolve => setTimeout(resolve, 100)); }
    }
    assert.ok(pronto, 'Servidor PHP iniciou');
    conferirSessao(await requisitar('session', 200));
    for (const estado of ['anonima', 'legada']) {
      if (estado === 'legada') {
        await fetch(`http://127.0.0.1:${porta}/sessao-antiga.php`, { headers: { Cookie: cookie } });
        conferirSessao(await requisitar('session', 200));
      }
      for (const acao of ['login', 'logout', 'samples', 'image', 'revise', 'deactivate', 'inexistente']) {
        await requisitar(acao, 404);
        await requisitar(acao, 404, 'POST', '{}');
      }
    }
    // As quatro ações atuais têm método definido; os métodos trocados falham antes de abrir o banco.
    for (const acao of ['session', 'taxonomy']) await requisitar(acao, 404, 'POST', '{}');
    for (const acao of ['save', 'predict']) {
      await requisitar(acao, 404);
      await requisitar(acao, 403, 'POST', '{}', false);
      await requisitar(acao, 422, 'POST', '{');
      await requisitar(acao, 422, 'POST', '[]');
    }
    await requisitar('save', 413, 'POST', JSON.stringify({ texto: 'a'.repeat(1600000) }));
    await requisitar('session', 405, 'PUT');
    await requisitar('x&action%5B%5D=session', 404);
    console.log(`OK: ${verificacoes} requisições verificadas; rotas removidas retornam 404, inclusive em sessão administrativa antiga.`);
  } finally {
    if (servidor.exitCode === null && !falhaInicio) {
      const encerrou = new Promise(resolve => servidor.once('exit', resolve));
      servidor.kill();
      await encerrou;
    }
    fs.closeSync(log);
    console.log(`Arquivos temporários do teste: ${temporario}`);
  }
})().catch(erro => { console.error(erro); process.exitCode = 1; });
