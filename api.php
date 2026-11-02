<?php
// Exige tipos compatíveis nas chamadas feitas por este arquivo, evitando conversões escalares implícitas.
declare(strict_types=1);

/**
O api.php é essencial durante a execução do site. Ele recebe as solicitações do app.js e faz a comunicação com o PostgreSQL.

Atualmente, possui quatro operações:
- session: fornece o token de segurança e informa se a configuração está disponível.
- taxonomy: consulta espécies e raças dos exemplos cadastrados.
- predict: compara o vetor da foto com os exemplos salvos para encontrar animais semelhantes.
- save: grava fotos, vetores, dados e correções.
Também valida os dados e protege as gravações. Precisa estar no servidor com suporte a PHP. Sem ele, a análise inicial no navegador pode funcionar, mas o aprendizado com exemplos cadastrados fica indisponível.
 */

// Carrega as funções de configuração, conexão PostgreSQL, validação de textos, espécies e vetores.
require __DIR__ . '/lib.php';
// Todas as respostas da API são JSON; fotos não são disponibilizadas por uma rota de consulta.
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');
ini_set('display_errors', '0');
// A sessão anônima mantém o token CSRF e a autorização para corrigir os próprios envios, sem conta ou senha.
ini_set('session.use_strict_mode', '1');
session_name('ANIMAIS_IA_SESSION');
// Cookie da sessão: indisponível ao JavaScript, restrito ao mesmo site e ao caminho desta aplicação.
session_set_cookie_params([
    'httponly' => true,
    'samesite' => 'Strict',
    'secure' => !empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off',
    'path' => rtrim(str_replace('\\', '/', dirname($_SERVER['SCRIPT_NAME'])), '/') . '/',
]);
session_start();
// Cria o token apenas se a sessão ainda não tiver um; o cliente deve enviá-lo no cabeçalho X-CSRF-Token.
$_SESSION['csrf'] ??= bin2hex(random_bytes(32));

/** Única saída JSON: encerra imediatamente para não juntar respostas ou continuar uma gravação. */
// Função resposta: $dados é o conteúdo convertido em JSON; $codigo é o status HTTP (200 por padrão).
// O retorno never indica que a função encerra a execução e não retorna ao ponto da chamada.
function resposta(array $dados, int $codigo = 200): never
{
    http_response_code($codigo);
    echo json_encode($dados, JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR);
    exit();
}

// Conexão PDO, criada apenas nas ações que precisam de banco. null permite tratar falhas anteriores à conexão.
$db = null;
try {
    // Despacho por ação e método, com limites antes da decodificação de corpos grandes.
    // Nome da operação pedido na URL; sem action, a API consulta o estado da sessão.
    $acao = $_GET['action'] ?? 'session';
    // Método HTTP recebido, como GET para consulta ou POST para envio de dados.
    $metodo = $_SERVER['REQUEST_METHOD'];
    if (!in_array($metodo, ['GET', 'POST'], true)) {
        resposta(['error' => 'Método não permitido.'], 405);
    }
    // Lista explícita das ações utilizadas pelo JavaScript e seus métodos HTTP.
    // Rejeita rotas inexistentes antes de abrir o banco ou processar o corpo enviado.
    $rotas = ['session' => 'GET', 'taxonomy' => 'GET', 'predict' => 'POST', 'save' => 'POST'];
    if (!is_string($acao) || !isset($rotas[$acao]) || $rotas[$acao] !== $metodo) {
        resposta(['error' => 'Rota não encontrada.'], 404);
    }
    // Objeto JSON recebido no POST, representado como array associativo; permanece vazio nas consultas GET.
    $dados = [];
    if ($metodo === 'POST') {
        // Não aceita uma gravação iniciada sem o token da sessão que abriu a página.
        if (!hash_equals($_SESSION['csrf'], $_SERVER['HTTP_X_CSRF_TOKEN'] ?? '')) {
            resposta(['error' => 'Sessão inválida. Recarregue a página.'], 403);
        }
        if ((int) ($_SERVER['CONTENT_LENGTH'] ?? 0) > 1600000) {
            resposta(['error' => 'Envio muito grande.'], 413);
        }
        // Corpo bruto da requisição. Lê um byte além do limite para detectar envios maiores que 1.600.000 bytes.
        $conteudo = file_get_contents('php://input', false, null, 0, 1600001);
        if (strlen($conteudo) > 1600000) {
            resposta(['error' => 'Envio muito grande.'], 413);
        }
        $dados = json_decode($conteudo, true, 64, JSON_THROW_ON_ERROR);
        if (!is_array($dados) || !str_starts_with(ltrim($conteudo), '{')) {
            throw new InvalidArgumentException('Envie um objeto JSON.');
        }
    }
    // GET session: informa o token CSRF e a disponibilidade da configuração, sem abrir o banco.
    if ($acao === 'session' && $metodo === 'GET') {
        // Expõe somente disponibilidade e token; nunca credenciais.
        // $configurado informa se o arquivo de configuração é válido; isso não comprova uma conexão ativa com o banco.
        // O retorno de animalConfig não precisa ser guardado nesta ação: somente sua validação é utilizada.
        try {
            animalConfig();
            $configurado = true;
        } catch (Throwable) {
            $configurado = false;
        }
        resposta([
            'configured' => $configurado,
            'csrf' => $_SESSION['csrf'],
        ]);
    }
    // Abre a conexão PostgreSQL usando as credenciais privadas e as opções PDO definidas em lib.php.
    $db = animalDb(animalConfig());
    // GET taxonomy: devolve as combinações de espécie e raça usadas nas sugestões do formulário.
    if ($acao === 'taxonomy' && $metodo === 'GET') {
        // Opções dos combos vêm de exemplos ativos/confirmados. Não expõe fotos nem observações.
        // Linhas com espécies e raças diferentes, obtidas apenas de fotos ativas e confirmadas.
        $rotulos = $db
            ->query(
                'SELECT DISTINCT a.especie, a.raca
            FROM animal_ia.animais a JOIN animal_ia.amostras s ON s.animal_id = a.id
            WHERE s.ativo AND s.confirmado ORDER BY a.especie, a.raca',
            )
            ->fetchAll();
        // Mapa de rótulos válidos sem repetição após converter os nomes das espécies para a forma oficial.
        $permitidos = [];
        // $rotulo representa cada combinação retornada pelo banco.
        foreach ($rotulos as $rotulo) {
            // Converte a espécie para uma das oito opções aceitas; retorna null para nomes fora do escopo.
            $especie = animalSpecies($rotulo['especie']);
            if ($especie) {
                $permitidos[$especie . '\0' . $rotulo['raca']] = [
                    'especie' => $especie,
                    'raca' => $rotulo['raca'],
                ];
            }
        }
        resposta(['labels' => array_values($permitidos)]);
    }
    // Validação compartilhada por cadastro e reconhecimento: as versões e o vetor devem ser compatíveis com o modelo esperado.
    if (in_array($acao, ['save', 'predict'], true) && $metodo === 'POST') {
        // Uma dimensão correta sozinha não garante compatibilidade: confira também ambas as versões.
        if (
            ($dados['extractor'] ?? null) !== ANIMAL_EXTRACTOR ||
            ($dados['preprocess'] ?? null) !== ANIMAL_PREPROCESS
        ) {
            throw new InvalidArgumentException(
                'Versão do extrator incompatível. Recarregue a página.',
            );
        }
        // Array de 1.280 números validado e normalizado por animalVector; representa as características visuais da foto.
        $vetor = animalVector($dados['embedding'] ?? null);
    }
    // POST predict: compara o vetor recebido com exemplos confirmados e devolve uma correspondência aceita ou null.
    if ($acao === 'predict' && $metodo === 'POST') {
        // Busca exata para a base inicial pequena, sem exigir extensão pgvector no servidor.
        $consulta = $db->prepare('SELECT s.animal_id, array_to_json(s.embedding) AS embedding,
            a.especie, a.raca FROM animal_ia.amostras s JOIN animal_ia.animais a ON a.id = s.animal_id
            WHERE s.ativo AND s.confirmado AND s.extrator_versao = ? AND s.preprocessamento_versao = ?');
        $consulta->execute([ANIMAL_EXTRACTOR, ANIMAL_PREPROCESS]);
        // Mapa que conserva somente a foto mais parecida de cada animal cadastrado.
        $melhores = [];
        // Contador de registros com espécie válida percorridos na busca, antes da verificação da dimensão do vetor.
        $total = 0;
        // $linha é uma amostra retornada pelo banco; o laço processa um registro por vez.
        while ($linha = $consulta->fetch()) {
            // Registros fora das oito espécies são preservados no banco, mas não participam da busca.
            $linha['especie'] = animalSpecies($linha['especie']);
            if (!$linha['especie']) {
                continue;
            }
            $total++;
            // Vetor do exemplo salvo no banco, convertido do JSON para um array de números.
            $referencia = json_decode($linha['embedding'], true, 64, JSON_THROW_ON_ERROR);
            if (count($referencia) !== ANIMAL_DIMENSIONS) {
                continue;
            }
            // Acumulador do produto escalar: soma os produtos das posições correspondentes dos dois vetores.
            $similaridade = 0.0;
            // Produto escalar de vetores normalizados equivale à similaridade cosseno.
            // $i é a posição no vetor e $valor é o número recebido nessa posição; vetores normalizados permitem medir similaridade cosseno.
            foreach ($vetor as $i => $valor) {
                $similaridade += $valor * $referencia[$i];
            }
            $similaridade = max(-1.0, min(1.0, $similaridade));
            // ID do animal usado como chave para agrupar suas fotos e evitar referências repetidas no ranking.
            $chave = $linha['animal_id'];
            // Referências legadas podem ter várias fotos: conserva só a mais próxima por referência.
            if (!isset($melhores[$chave]) || $similaridade > $melhores[$chave]['similarity']) {
                // A resposta pública contém apenas rótulos e pontuação, sem IDs das referências.
                $melhores[$chave] = [
                    'especie' => $linha['especie'],
                    'raca' => $linha['raca'],
                    'similarity' => $similaridade,
                ];
            }
        }
        // Ordena do maior para o menor grau de semelhança; $a e $b são os dois resultados comparados a cada passo.
        usort($melhores, static fn($a, $b) => $b['similarity'] <=> $a['similarity']);
        // Até três referências com maior similaridade; são os vizinhos mais próximos da foto consultada.
        $vizinhos = array_slice($melhores, 0, 3);
        // Melhor resultado encontrado, ou null quando não existe uma referência válida.
        $primeiro = $vizinhos[0] ?? null;
        // Um único exemplar só é aceito como referência muito próxima, nunca como certeza da raça.
        // Indica se o segundo resultado tem similaridade suficiente e concorda com a espécie e a raça do primeiro.
        $concordam =
            isset($vizinhos[1]) &&
            $vizinhos[1]['similarity'] >= 0.85 &&
            $vizinhos[1]['especie'] === $primeiro['especie'] &&
            $vizinhos[1]['raca'] === $primeiro['raca'];
        // Aceita uma referência com pelo menos 0,97 de similaridade, ou pelo menos 0,85 com concordância da segunda referência.
        $aceito =
            $primeiro &&
            ($primeiro['similarity'] >= 0.97 || ($primeiro['similarity'] >= 0.85 && $concordam));
        resposta([
            'match' => $aceito ? $primeiro : null,
            'neighbors' => $vizinhos,
            'total' => $total,
        ]);
    }
    // POST save: valida a foto e os rótulos, cadastra uma referência ou trata uma correção, sempre dentro de transação.
    if ($acao === 'save' && $metodo === 'POST') {
        // IDs mantidos somente para autorizar a correção da própria foto; não formam uma galeria consultável.
        $enviadas = array_map('intval', $_SESSION['amostras_enviadas'] ?? []);
        // O formulário explícito de cadastro confirma os rótulos; inferências não são salvas sozinhas.
        if (($dados['confirmed'] ?? false) !== true) {
            throw new InvalidArgumentException(
                'Confirme os rótulos antes de salvar para aprendizado.',
            );
        }
        // Identificação opcional do animal. Sem um código informado, será gerada uma identificação AUTO aleatória.
        $codigo = strtoupper(animalText($dados, 'identificacao', 60, false));
        if ($codigo === '') {
            $codigo = 'AUTO-' . strtoupper(bin2hex(random_bytes(12)));
        }
        if (!preg_match('/^[A-Z0-9_-]{1,60}$/D', $codigo)) {
            throw new InvalidArgumentException(
                'Use letras, números, hífen ou sublinhado na identificação.',
            );
        }
        // Nome de espécie validado e convertido para a forma oficial aceita pela aplicação.
        $especie = animalSpecies(animalText($dados, 'especie', 100));
        if (!$especie) {
            throw new InvalidArgumentException(
                'Selecione cachorro, gato, cavalo, bovino, ovelha, galinha, pato ou ganso.',
            );
        }
        // Raça informada, com limite de tamanho; usa Não identificada quando o campo vem vazio.
        $raca = animalText($dados, 'raca', 100, false) ?: 'Não identificada';
        // Texto opcional de observações, validado com limite de 2.000 bytes.
        $observacoes = animalText($dados, 'observacoes', 2000, false);
        // Imagem recebida como uma URL de dados: prefixo JPEG seguido dos bytes codificados em base64.
        $base64 = $dados['image'] ?? null;
        // Decodifica em modo estrito e verifica conteúdo, dimensões e limite, sem confiar na extensão.
        if (!is_string($base64) || !str_starts_with($base64, 'data:image/jpeg;base64,')) {
            throw new InvalidArgumentException('Envie uma foto JPEG.');
        }
        // Remove o prefixo de 23 caracteres e decodifica a foto; retorna false se o base64 for inválido.
        $foto = base64_decode(substr($base64, 23), true);
        // Lê as dimensões e o tipo real da imagem; o @ suprime avisos de conteúdo inválido, tratado na condição seguinte.
        $info = $foto === false ? false : @getimagesizefromstring($foto);
        if (
            !$info ||
            strlen($foto) > 1048576 ||
            $info[0] !== 512 ||
            $info[1] !== 512 ||
            $info['mime'] !== 'image/jpeg'
        ) {
            throw new InvalidArgumentException('A foto deve ser JPEG de 512 × 512, até 1 MB.');
        }
        // Metadados das sugestões anteriores da IA, preservados para consulta e auditoria da correção.
        $sugestao = $dados['suggestion'] ?? null;
        if (
            $sugestao !== null &&
            (!is_array($sugestao) || strlen(json_encode($sugestao)) > 10000)
        ) {
            throw new InvalidArgumentException('Sugestão inválida.');
        }
        // Animal + foto + vetor entram juntos; uma foto duplicada desfaz também a referência nova.
        // Inicia uma transação: as alterações relacionadas só se tornam definitivas após commit; uma falha permite revertê-las.
        $db->beginTransaction();
        // Uma correção da foto já cadastrada não deve ser bloqueada como simples duplicidade.
        // Fotos da própria sessão podem receber novo rótulo; registros alheios geram só sugestão pendente.
        if (($dados['correction'] ?? false) === true) {
            // Busca a mesma foto pelo hash e pelas versões; FOR UPDATE bloqueia a amostra durante a correção concorrente.
            $consultaFoto = $db->prepare('SELECT s.id, s.animal_id, s.sugestao_original, a.especie, a.raca
                FROM animal_ia.amostras s JOIN animal_ia.animais a ON a.id = s.animal_id
                WHERE s.foto_sha256 = ? AND s.extrator_versao = ? AND s.preprocessamento_versao = ? FOR UPDATE OF s');
            $consultaFoto->execute([hash('sha256', $foto), ANIMAL_EXTRACTOR, ANIMAL_PREPROCESS]);
            // Registro da foto já cadastrada, ou false caso esta imagem ainda não exista nessa versão do extrator.
            $fotoAnterior = $consultaFoto->fetch();
            if ($fotoAnterior) {
                // Dados anteriores usados no histórico de revisão, incluindo a referência original e os metadados da amostra.
                $antes = [
                    'especie' => $fotoAnterior['especie'],
                    'raca' => $fotoAnterior['raca'],
                    'amostra_id' => (int) $fotoAnterior['id'],
                    'animal_id_anterior' => (int) $fotoAnterior['animal_id'],
                    'sugestao_original' =>
                        $fotoAnterior['sugestao_original'] === null
                            ? null
                            : json_decode(
                                $fotoAnterior['sugestao_original'],
                                true,
                                64,
                                JSON_THROW_ON_ERROR,
                            ),
                ];
                // true somente quando o ID da foto consta entre os envios desta sessão; controla a aplicação direta da correção pública.
                $propria = in_array((int) $fotoAnterior['id'], $enviadas, true);
                // Novos rótulos e estado da revisão: aplicada à própria foto ou pendente para foto de outra sessão.
                $depois = [
                    'especie' => $especie,
                    'raca' => $raca,
                    'tipo' => 'correcao_publica',
                    'estado' => $propria ? 'aplicada' : 'pendente',
                ];
                // Referência associada à revisão; pode mudar se a correção criar um novo animal para a própria foto.
                $animalRevisao = $fotoAnterior['animal_id'];
                if ($propria) {
                    // Cria outra referência em vez de alterar o animal compartilhado da foto anterior.
                    // Assim, até uma foto anexada a um código legado não modifica outras fotos daquele código.
                    // Comando que cria uma referência independente para não modificar outras fotos ligadas ao animal anterior.
                    $novaReferencia = $db->prepare('INSERT INTO animal_ia.animais (identificacao,especie,raca,observacoes)
                        VALUES (?,?,?,?) RETURNING id');
                    $novaReferencia->execute([
                        'AUTO-' . strtoupper(bin2hex(random_bytes(12))),
                        $especie,
                        $raca,
                        $observacoes,
                    ]);
                    $animalRevisao = $novaReferencia->fetchColumn();
                    // Informações salvas na amostra para registrar a sugestão da IA e os rótulos confirmados na correção.
                    $metadados = [
                        'ia' => $sugestao,
                        'rotulos_informados' => ['especie' => $especie, 'raca' => $raca],
                        'correcao_da_identificacao' => true,
                    ];
                    $db->prepare(
                        'UPDATE animal_ia.amostras SET animal_id = ?, sugestao_original = CAST(? AS jsonb) WHERE id = ?',
                    )->execute([
                        $animalRevisao,
                        json_encode($metadados, JSON_THROW_ON_ERROR),
                        $fotoAnterior['id'],
                    ]);
                }
                $db->prepare(
                    'INSERT INTO animal_ia.revisoes (animal_id,antes,depois,motivo)
                    VALUES (?,CAST(? AS jsonb),CAST(? AS jsonb),?)',
                )->execute([
                    $animalRevisao,
                    json_encode($antes, JSON_THROW_ON_ERROR),
                    json_encode($depois, JSON_THROW_ON_ERROR),
                    $propria
                        ? 'Correção da identificação pelo visitante que enviou a foto.'
                        : 'Sugestão pública de correção; cadastro anterior preservado.',
                ]);
                $db->commit();
                resposta([
                    'id' => (int) $fotoAnterior['id'],
                    'pending_review' => !$propria,
                    'message' => $propria
                        ? 'Correção salva e aplicada ao seu exemplo.'
                        : 'Correção recebida para revisão. O cadastro anterior foi preservado.',
                ]);
            }
        }
        // Comando preparado para cadastrar o animal; se o código já existir, mantém o cadastro existente.
        $inserir = $db->prepare('INSERT INTO animal_ia.animais (identificacao, especie, raca, observacoes)
            VALUES (?, ?, ?, ?) ON CONFLICT (identificacao) DO NOTHING');
        $inserir->execute([$codigo, $especie, $raca, $observacoes]);
        // Indica que a inserção não criou um animal porque a identificação já estava cadastrada.
        $existente = $inserir->rowCount() === 0;
        // Lê somente o ID usado na gravação da foto e bloqueia o animal até concluir a transação.
        $consulta = $db->prepare(
            'SELECT id FROM animal_ia.animais WHERE identificacao = ? FOR UPDATE',
        );
        $consulta->execute([$codigo]);
        // Registro do animal identificado pelo código; nesta operação, somente o campo id é necessário.
        $animal = $consulta->fetch();
        // Adiciona fotos ao animal existente sem sobrescrever sua classificação.
        // Metadados que distinguem os rótulos informados, um cadastro já existente e uma eventual correção.
        $registroSugestao = [
            'ia' => $sugestao,
            'rotulos_informados' => ['especie' => $especie, 'raca' => $raca],
            'animal_ja_existia' => $existente,
            'correcao_da_identificacao' => ($dados['correction'] ?? false) === true,
        ];
        // Comando para salvar foto, hash, vetor, versões, metadados e observações em uma nova amostra confirmada.
        $inserir = $db->prepare('INSERT INTO animal_ia.amostras
            (animal_id, foto, foto_sha256, embedding, extrator_versao, preprocessamento_versao, sugestao_original, observacoes, confirmado)
            VALUES (?, decode(?, \'base64\'), ?, CAST(? AS real[]), ?, ?, CAST(? AS jsonb), ?, true) RETURNING id');
        $inserir->execute([
            $animal['id'],
            base64_encode($foto),
            hash('sha256', $foto),
            '{' . implode(',', $vetor) . '}',
            ANIMAL_EXTRACTOR,
            ANIMAL_PREPROCESS,
            json_encode($registroSugestao, JSON_THROW_ON_ERROR),
            $observacoes,
        ]);
        // ID da amostra criada, devolvido pela cláusula RETURNING id do PostgreSQL.
        $id = $inserir->fetchColumn();
        $db->commit();
        // Limita a lista interna de autorização de correções a 500 IDs, sem remover amostras do banco.
        $_SESSION['amostras_enviadas'] = array_slice(
            array_values(array_unique([...$enviadas, (int) $id])),
            -500,
        );
        resposta(
            [
                'id' => (int) $id,
                'existing_animal' => $existente,
                'message' => $existente
                    ? 'Nova foto e vetor salvos no PostgreSQL para o animal existente. Espécie e raça do cadastro anterior foram mantidas.'
                    : 'Foto e vetor confirmados salvos no PostgreSQL.',
            ],
            201,
        );
    }
    // Nenhuma combinação de ação e método acima correspondeu à requisição.
    resposta(['error' => 'Rota não encontrada.'], 404);
} catch (InvalidArgumentException | JsonException $erro) {
    // $erro contém uma falha de validação ou de JSON; a resposta 422 explica qual entrada precisa ser corrigida.
    // Erros de entrada podem ser mostrados ao cliente; transações incompletas são revertidas.
    if ($db?->inTransaction()) {
        $db->rollBack();
    }
    resposta(['error' => $erro->getMessage()], 422);
} catch (PDOException $erro) {
    // $erro contém uma falha de banco; o código SQLSTATE permite distinguir foto duplicada de outras falhas.
    // Não devolve SQL nem a mensagem bruta da conexão, que pode conter dados de infraestrutura.
    if ($db?->inTransaction()) {
        $db->rollBack();
    }
    if ($erro->getCode() === '23505') {
        resposta(
            [
                'error' =>
                    'Esta foto já foi cadastrada. Use outra foto ou corrija o cadastro existente.',
            ],
            409,
        );
    }
    error_log('Animais IA: falha de banco, SQLSTATE ' . $erro->getCode());
    resposta(
        ['error' => 'Banco indisponível. Confira a conexão, pdo_pgsql e execute a migração.'],
        503,
    );
} catch (Throwable $erro) {
    // Captura as demais falhas. Registra somente o tipo do erro e devolve uma mensagem pública sem detalhes privados.
    // Última proteção para falhas de instalação/configuração sem revelar arquivos privados.
    if ($db?->inTransaction()) {
        $db->rollBack();
    }
    error_log('Animais IA: falha interna do tipo ' . get_class($erro));
    resposta(
        [
            'error' =>
                'Serviço não configurado ou indisponível. Confira a configuração da aplicação.',
        ],
        503,
    );
}
