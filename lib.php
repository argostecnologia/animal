<?php
declare(strict_types=1);

/** Funções compartilhadas por API e migração; não envia respostas HTTP por conta própria. */

// Devem corresponder às constantes de app.js. Vetores de modelos diferentes não são misturados.
const ANIMAL_EXTRACTOR = 'mobilenet-js-2.1.1-v2-alpha1';
const ANIMAL_PREPROCESS = 'letterbox-512-rgb-v1';
const ANIMAL_DIMENSIONS = 1280;

// Distingue erros de configuração com mensagens seguras de falhas internas ou de banco.
class AnimalConfigException extends RuntimeException {}

/** Sinônimos permitidos, incluindo nomes usados em cadastros antigos; não modifica esses registros. */
function animalSpeciesAliases(): array {
    return ['cachorro'=>'Cachorro','cachorros'=>'Cachorro','cão'=>'Cachorro','cao'=>'Cachorro',
        'gato'=>'Gato','gatos'=>'Gato','cavalo'=>'Cavalo','cavalos'=>'Cavalo',
        'bovino'=>'Bovino','bovinos'=>'Bovino','boi'=>'Bovino','vaca'=>'Bovino',
        'ovelha'=>'Ovelha','ovelhas'=>'Ovelha','ovino'=>'Ovelha','ovinos'=>'Ovelha',
        'galinha'=>'Galinha','galinhas'=>'Galinha','pato'=>'Pato','patos'=>'Pato',
        'ganso'=>'Ganso','gansos'=>'Ganso'];
}

/** Retorna uma das oito espécies canônicas, ou null para um grupo fora do escopo. */
function animalSpecies(string $valor): ?string {
    $chave = strtolower(strtr(trim($valor), ['Ã'=>'ã','Á'=>'á','É'=>'é']));
    return animalSpeciesAliases()[$chave] ?? null;
}

/** Lê credenciais fora da pasta pública. ANIMAIS_CONFIG_FILE permite configuração em testes/local. */
function animalConfig(): array {
    $arquivo = getenv('ANIMAIS_CONFIG_FILE') ?: dirname(__DIR__, 2) . '/config/animais-ia.php';
    if (!is_file($arquivo)) {
        throw new AnimalConfigException('Configuração ausente. Configure animais-ia.php fora da pasta pública.');
    }
    // Um arquivo sem <?php pode passar no lint, mas imprimir seu conteúdo no require.
    // Descarte qualquer saída para nunca devolver credenciais ao terminal ou à API.
    ob_start();
    try { $config = require $arquivo; }
    finally { ob_end_clean(); }
    foreach (['dsn', 'user', 'password'] as $campo) {
        if (!is_array($config) || !isset($config[$campo]) || !is_string($config[$campo])) {
            throw new AnimalConfigException("Configuração incompleta: confira o campo '$campo' e o return do arquivo.");
        }
    }
    if (!str_starts_with($config['dsn'], 'pgsql:')) {
        throw new AnimalConfigException("O campo 'dsn' deve começar com pgsql:.");
    }
    return $config;
}

/** Conexão PostgreSQL com exceções e parâmetros preparados nativos, sem concatenar dados em SQL. */
function animalDb(array $config): PDO {
    return new PDO($config['dsn'], $config['user'], $config['password'], [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        PDO::ATTR_EMULATE_PREPARES => false,
    ]);
}

/** Valida dimensão/números finitos e normaliza o vetor para comprimento 1 (norma L2). */
function animalVector(mixed $input): array {
    if (!is_array($input) || !array_is_list($input) || count($input) !== ANIMAL_DIMENSIONS) {
        throw new InvalidArgumentException('O vetor deve conter 1280 números.');
    }
    // Limita valores extremos antes de somar os quadrados, evitando estouros numéricos.
    $norma = 0.0;
    foreach ($input as $valor) {
        if ((!is_int($valor) && !is_float($valor)) || !is_finite((float)$valor) || abs($valor) > 1e6) {
            throw new InvalidArgumentException('O vetor contém valores inválidos.');
        }
        $norma += $valor * $valor;
    }
    if ($norma <= 1e-12) throw new InvalidArgumentException('O vetor não pode ser vazio.');
    $norma = sqrt($norma);
    return array_map(static fn($valor) => $valor / $norma, $input);
}

/** Extrai um texto, remove espaços nas pontas e aplica limite em bytes; nunca imprime seu conteúdo. */
function animalText(array $dados, string $campo, int $limite, bool $obrigatorio = true): string {
    $valor = $dados[$campo] ?? '';
    if (!is_string($valor)) throw new InvalidArgumentException("Campo inválido: $campo.");
    $valor = trim($valor);
    if (($obrigatorio && $valor === '') || strlen($valor) > $limite) {
        throw new InvalidArgumentException("Preencha $campo respeitando o limite de $limite bytes.");
    }
    return $valor;
}
