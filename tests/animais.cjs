// Requer PHP com pdo_pgsql, binários PostgreSQL e Playwright + Chrome.
// PHP_BIN aponta para php.exe. PG_BIN aponta para a pasta bin do PostgreSQL.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn, execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const php = process.env.PHP_BIN || 'php';
const pgBin = process.env.PG_BIN || 'C:/Program Files/PostgreSQL/18/bin';
const phpArgs = process.env.PHP_EXTENSION_DIR ? ['-d', `extension_dir="${process.env.PHP_EXTENSION_DIR.replaceAll('\\', '/')}"`, '-d', 'extension=pdo_pgsql'] : [];
// O teste atualiza a configuração durante a execução; não reutilize bytecode antigo.
phpArgs.push('-d', 'opcache.enable=0', '-d', 'opcache.enable_cli=0');
// Executa utilitários sem janelas adicionais; falhas propagam o código de saída ao teste.
function run(exe, args, opts = {}) { return execFileSync(exe, args, { windowsHide: true, encoding: 'utf8', ...opts }); }
// Usa portas livres para não interferir com PostgreSQL/servidores já abertos no computador.
async function port() {
  const s = net.createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r));
  const value = s.address().port; await new Promise(r => s.close(r)); return value;
}
// Sonda a inicialização local com espera limitada; não exige que o extrator visual já esteja carregado.
async function ready(url) {
  for (let i = 0; i < 100; i++) { try { await fetch(url); return; } catch { await new Promise(r => setTimeout(r, 100)); } }
  throw new Error('Servidor de teste não iniciou.');
}
(async () => {
  // Diretório novo por execução: dados e logs nunca apontam para o banco de produção.
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'animais-integration-'));
  const pgdata = path.join(temp, 'pgdata'), pgPort = await port(), httpPort = await port();
  let pgStarted = false, server, browser;
  try {
    // Cria um cluster restrito a 127.0.0.1 e aplica a migração de forma repetível.
    run(path.join(pgBin, 'initdb.exe'), ['-D', pgdata, '-U', 'animais_test', '-A', 'trust', '--no-locale', '-E', 'UTF8']);
    run(path.join(pgBin, 'pg_ctl.exe'), ['-D', pgdata, '-l', path.join(temp, 'postgres.log'), '-o', `-p ${pgPort} -h 127.0.0.1`, '-w', 'start'], { stdio: 'ignore', timeout: 60000 });
    pgStarted = true;
    const config = path.join(temp, 'config.php');
    const configSemSenha = `<?php return ['dsn'=>'pgsql:host=127.0.0.1;port=${pgPort};dbname=postgres','user'=>'animais_test','password'=>''];`;
    fs.writeFileSync(config, configSemSenha);
    const env = { ...process.env, ANIMAIS_CONFIG_FILE: config };
    run(php, [...phpArgs, 'migrate.php'], { cwd: root, env });
    run(php, [...phpArgs, 'migrate.php'], { cwd: root, env }); // Migração repetível.
    assert.match(run(php, [...phpArgs, 'migrate.php', '--diagnostico'], { cwd: root, env }), /Nenhuma tabela foi criada ou alterada/);
    const log = fs.openSync(path.join(temp, 'php.log'), 'a');
    // O roteador local simula /animal para que as mesmas URLs relativas sejam usadas na VPS.
    server = spawn(php, [...phpArgs, '-S', `127.0.0.1:${httpPort}`, 'tools/dev-router.php'], { cwd: root, env, windowsHide: true, stdio: ['ignore', log, log] });
    const base = `http://127.0.0.1:${httpPort}/animal/`; await ready(base);
    // Cadastro e identificação são públicos; rotas antigas de administração e histórico não existem.
    const anonymous = await fetch(base + 'api.php?action=samples'); assert.equal(anonymous.status, 404);
    const session = await fetch(base + 'api.php?action=session');
    const cookie = session.headers.get('set-cookie').split(';')[0];
    const csrf = (await session.json()).csrf;
    assert.equal((await fetch(base + 'api.php?action=save', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({}) })).status, 403);
    browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
    await require('./cards-flow.cjs')({browser,base,run,pgBin,pgPort,root,temp});
  } finally {
    // Mesmo após falha, encerra navegador, PHP e apenas a instância PostgreSQL criada neste teste.
    if (browser) await browser.close();
    if (server && !server.killed) { server.kill(); await new Promise(r => server.once('exit', r)); }
    if (pgStarted) run(path.join(pgBin, 'pg_ctl.exe'), ['-D', pgdata, '-m','fast','-w','stop'], { stdio: 'ignore', timeout: 60000 });
    console.log(`Logs e banco temporário de teste: ${temp}`);
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
