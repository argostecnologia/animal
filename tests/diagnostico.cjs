const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const assert = require('node:assert/strict');
const php = process.env.PHP_BIN || 'php';
const args = process.env.PHP_EXTENSION_DIR ? ['-d', `extension_dir="${process.env.PHP_EXTENSION_DIR.replaceAll('\\', '/')}"`, '-d', 'extension=pdo_pgsql'] : [];
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'animais-diagnostico-'));
const file = path.join(temp, 'config.php');
const root = path.resolve(__dirname, '..');
const segredo = 'NAO_PODE_APARECER_NA_SAIDA';
// Arquivos deliberadamente inválidos não podem fazer a migração imprimir credenciais.
function verificar(conteudo, esperado) {
  fs.writeFileSync(file, conteudo);
  const r = spawnSync(php, [...args, 'migrate.php', '--diagnostico'], { cwd: root, env: { ...process.env, ANIMAIS_CONFIG_FILE: file }, encoding: 'utf8', windowsHide: true });
  const output = (r.stdout || '') + (r.stderr || '');
  assert.equal(r.status, 1);
  assert.match(output, esperado);
  assert.equal(output.includes(segredo), false);
}
verificar(`Arquivo sem tag PHP com segredo ${segredo}`, /Configuração incompleta/);
verificar(`<?php return ['dsn'=>'mysql:host=127.0.0.1', 'user'=>'u', 'password'=>'${segredo}'];`, /deve começar com pgsql/);
verificar(`<?php return ['dsn'=>'pgsql:host=127.0.0.1', 'password'=>'${segredo}'];`, /campo 'user'/);
verificar(`<?php return [ 'password' => '${segredo}' 'broken' ];`, /Erro de sintaxe/);
console.log('OK: diagnóstico de configuração incompleta, DSN inválido e sintaxe, sem vazamento de credenciais.');
