// Conveniência: node server.cjs inicia o servidor de desenvolvimento PHP.
const { spawn } = require('node:child_process');
// Permite PHP portátil em Windows; aspas no extension_dir preservam caminhos com espaço ou til.
const extensoes = process.env.PHP_EXTENSION_DIR
  ? ['-d', `extension_dir="${process.env.PHP_EXTENSION_DIR.replaceAll('\\', '/')}"`, '-d', 'extension=pdo_pgsql'] : [];
// Escuta só neste computador. A VPS usa o Apache existente, não este servidor de desenvolvimento.
const php = spawn(process.env.PHP_BIN || 'php', [...extensoes, '-S', '127.0.0.1:8080', 'tools/dev-router.php'], {
  cwd: __dirname, stdio: 'inherit', windowsHide: true, env: process.env
});
// Propaga encerramento/falhas e evita deixar o processo filho aberto ao pressionar Ctrl+C.
php.on('error', () => { console.error('PHP não encontrado. Instale PHP 8.1+ com pdo_pgsql ou defina PHP_BIN.'); process.exitCode = 1; });
php.on('exit', code => { process.exitCode = code || 0; });
process.on('SIGINT', () => php.kill());
