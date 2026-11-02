<?php
// Somente para o servidor de desenvolvimento php -S.
$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
// Simula a subpasta /animal da VPS sem mover os arquivos do repositório.
if ($path === '/' || $path === '/animal') { header('Location: /animal/index.html', true, 302); exit; }
// Lista fechada: configuração, SQL, testes e demais arquivos não são servidos neste ambiente local.
$files = ['index.html', 'app.js', 'style.css', 'catalogo.json', 'api.php'];
$relative = ltrim($path, '/');
// Remove o prefixo sem depender do diretório real no computador.
$prefixo = '/animal/';
if (str_starts_with($path, $prefixo)) $relative = substr($path, strlen($prefixo));
if ($relative === '' || $relative === 'animal') $relative = 'index.html';
if (!in_array($relative, $files, true)) { http_response_code(404); exit('Não encontrado'); }
$file = dirname(__DIR__) . '/' . $relative;
if ($relative === 'api.php') {
    // SCRIPT_NAME correto mantém o cookie de sessão limitado à subpasta da aplicação.
    $_SERVER['SCRIPT_NAME'] = '/animal/api.php';
    require $file;
} else {
    // MIME explícito e sem cache permitem visualizar alterações locais sem confundir versões.
    $types = ['html' => 'text/html', 'js' => 'text/javascript', 'css' => 'text/css', 'json' => 'application/json'];
    header('Content-Type: ' . $types[pathinfo($file, PATHINFO_EXTENSION)] . '; charset=utf-8');
    header('Cache-Control: no-store');
    readfile($file);
}
