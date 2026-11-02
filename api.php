<?php
declare(strict_types=1);
/**
 * API JSON da identificação de animais.
 * Públicas: session, taxonomy, predict e save; samples mostra só contribuições da sessão.
 * Protegidas: image, revise e deactivate. Login administrativo é opcional e separado do ERP.
 * Senhas do PostgreSQL ficam exclusivamente no arquivo privado carregado por lib.php.
 */
require __DIR__ . '/lib.php';
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');
ini_set('display_errors', '0');
// A sessão anônima guarda o token CSRF e os IDs enviados por este visitante, sem exigir conta.
ini_set('session.use_strict_mode', '1');
session_name('ANIMAIS_IA_SESSION');
session_set_cookie_params([
    'httponly' => true, 'samesite' => 'Strict',
    'secure' => !empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off',
    'path' => rtrim(str_replace('\\', '/', dirname($_SERVER['SCRIPT_NAME'])), '/') . '/',
]);
session_start();
$_SESSION['csrf'] ??= bin2hex(random_bytes(32));

/** Única saída JSON: encerra imediatamente para não juntar respostas ou continuar uma gravação. */
function resposta(array $dados, int $codigo = 200): never {
    http_response_code($codigo);
    echo json_encode($dados, JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR);
    exit;
}

$db = null;
try {
    // Despacho por ação e método, com limites antes da decodificação de corpos grandes.
    $acao = $_GET['action'] ?? 'session';
    $metodo = $_SERVER['REQUEST_METHOD'];
    if (!in_array($metodo, ['GET', 'POST'], true)) resposta(['error' => 'Método não permitido.'], 405);
    $dados = [];
    if ($metodo === 'POST') {
        // Não aceita uma gravação iniciada sem o token da sessão que abriu a página.
        if (!hash_equals($_SESSION['csrf'], $_SERVER['HTTP_X_CSRF_TOKEN'] ?? '')) {
            resposta(['error' => 'Sessão inválida. Recarregue a página.'], 403);
        }
        if ((int)($_SERVER['CONTENT_LENGTH'] ?? 0) > 1600000) resposta(['error' => 'Envio muito grande.'], 413);
        $conteudo = file_get_contents('php://input', false, null, 0, 1600001);
        if (strlen($conteudo) > 1600000) resposta(['error' => 'Envio muito grande.'], 413);
        $dados = json_decode($conteudo, true, 64, JSON_THROW_ON_ERROR);
        if (!is_array($dados) || !str_starts_with(ltrim($conteudo), '{')) throw new InvalidArgumentException('Envie um objeto JSON.');
    }
    if ($acao === 'session' && $metodo === 'GET') {
        // Expõe somente disponibilidade, estado administrativo e token; nunca credenciais.
        try { $config = animalConfig(); $configurado = true; } catch (Throwable) { $configurado = false; }
        resposta(['authenticated' => !empty($_SESSION['admin']), 'configured' => $configurado,
            'public_contributions' => true, 'csrf' => $_SESSION['csrf']]);
    }
    if ($acao === 'login' && $metodo === 'POST') {
        // Compatibilidade para manutenção administrativa via API; não faz parte da tela pública.
        $config = animalConfig();
        if (!is_string($config['admin_password_hash'] ?? null)
            || password_get_info($config['admin_password_hash'])['algoName'] === 'unknown') {
            resposta(['error' => 'Acesso administrativo não configurado. O envio de fotos e a identificação não precisam de senha.'], 503);
        }
        if (($_SESSION['bloqueado_ate'] ?? 0) > time()) resposta(['error' => 'Aguarde um minuto para tentar novamente.'], 429);
        if (!is_string($dados['password'] ?? null) || !password_verify($dados['password'], $config['admin_password_hash'])) {
            $_SESSION['falhas'] = ($_SESSION['falhas'] ?? 0) + 1;
            if ($_SESSION['falhas'] >= 5) { $_SESSION['bloqueado_ate'] = time() + 60; $_SESSION['falhas'] = 0; }
            resposta(['error' => 'Senha inválida.'], 401);
        }
        session_regenerate_id(true);
        $_SESSION['admin'] = true;
        $_SESSION['falhas'] = 0;
        $_SESSION['csrf'] = bin2hex(random_bytes(32));
        resposta(['authenticated' => true, 'csrf' => $_SESSION['csrf']]);
    }
    if ($acao === 'logout' && $metodo === 'POST') {
        // Remove só o acesso administrativo e preserva o histórico de envios desta sessão.
        unset($_SESSION['admin']);
        session_regenerate_id(true);
        resposta(['ok' => true]);
    }
    // Permissões são verificadas no servidor, mesmo que um cliente tente chamar rotas manualmente.
    $administrador = !empty($_SESSION['admin']);
    $enviadas = array_map('intval', $_SESSION['amostras_enviadas'] ?? []);
    if (!$administrador && in_array($acao, ['revise', 'deactivate'], true)) {
        resposta(['error' => 'Somente a administração pode alterar ou retirar cadastros existentes. Você pode enviar novas fotos sem senha.'], 403);
    }
    $db = animalDb(animalConfig());
    if ($acao === 'taxonomy' && $metodo === 'GET') {
        // Opções dos combos vêm de exemplos ativos/confirmados. Não expõe fotos nem observações.
        $rotulos = $db->query('SELECT DISTINCT a.especie, a.raca
            FROM animal_ia.animais a JOIN animal_ia.amostras s ON s.animal_id = a.id
            WHERE s.ativo AND s.confirmado ORDER BY a.especie, a.raca')->fetchAll();
        $permitidos = [];
        foreach ($rotulos as $rotulo) {
            $especie = animalSpecies($rotulo['especie']);
            if ($especie) $permitidos[$especie . '\0' . $rotulo['raca']] = ['especie'=>$especie, 'raca'=>$rotulo['raca']];
        }
        resposta(['labels' => array_values($permitidos)]);
    }
    if ($acao === 'samples' && $metodo === 'GET') {
        // Consulta legada preservada para manutenção; a interface simplificada não exibe histórico.
        $total = $db->query('SELECT count(*) FROM animal_ia.amostras WHERE ativo AND confirmado')->fetchColumn();
        // Visitantes veem apenas as fotos enviadas nesta sessão; acervo anterior é administrativo.
        $filtro = $administrador ? '' : ' AND s.id IN (' . implode(',', $enviadas ?: [0]) . ')';
        $notas = $administrador ? 'a.observacoes' : 's.observacoes';
        $linhas = $db->query('SELECT s.id, s.animal_id, a.identificacao, a.especie, a.raca, ' . $notas . ' AS observacoes,
            s.observacoes AS observacoes_foto, s.criado_em,
            s.extrator_versao, s.preprocessamento_versao FROM animal_ia.amostras s
            JOIN animal_ia.animais a ON a.id = s.animal_id WHERE s.ativo AND s.confirmado' . $filtro . '
            ORDER BY s.id DESC LIMIT 50')->fetchAll();
        resposta(['total' => (int)$total, 'samples' => $linhas, 'scope' => $administrador ? 'all' : 'own_session']);
    }
    if ($acao === 'image' && $metodo === 'GET') {
        // A foto sai como JPEG somente para administrador; o banco armazena os bytes em BYTEA.
        $id = filter_var($_GET['id'] ?? null, FILTER_VALIDATE_INT, ['options' => ['min_range' => 1]]);
        if (!$id) throw new InvalidArgumentException('Imagem inválida.');
        if (!$administrador) resposta(['error' => 'Imagem restrita à administração.'], 403);
        $consulta = $db->prepare('SELECT encode(foto, \'base64\') FROM animal_ia.amostras WHERE id = ? AND ativo');
        $consulta->execute([$id]);
        $foto = $consulta->fetchColumn();
        if ($foto === false) resposta(['error' => 'Imagem não encontrada.'], 404);
        header('Content-Type: image/jpeg');
        echo base64_decode($foto);
        exit;
    }
    if (in_array($acao, ['save', 'predict'], true) && $metodo === 'POST') {
        // Uma dimensão correta sozinha não garante compatibilidade: confira também ambas as versões.
        if (($dados['extractor'] ?? null) !== ANIMAL_EXTRACTOR || ($dados['preprocess'] ?? null) !== ANIMAL_PREPROCESS) {
            throw new InvalidArgumentException('Versão do extrator incompatível. Recarregue a página.');
        }
        $vetor = animalVector($dados['embedding'] ?? null);
    }
    if ($acao === 'predict' && $metodo === 'POST') {
        // Busca exata para a base inicial pequena, sem exigir extensão pgvector no servidor.
        $consulta = $db->prepare('SELECT s.id, s.animal_id, array_to_json(s.embedding) AS embedding,
            a.especie, a.raca FROM animal_ia.amostras s JOIN animal_ia.animais a ON a.id = s.animal_id
            WHERE s.ativo AND s.confirmado AND s.extrator_versao = ? AND s.preprocessamento_versao = ?');
        $consulta->execute([ANIMAL_EXTRACTOR, ANIMAL_PREPROCESS]);
        $melhores = [];
        $total = 0;
        while ($linha = $consulta->fetch()) {
            // Registros fora das oito espécies são preservados no banco, mas não participam da busca.
            $linha['especie'] = animalSpecies($linha['especie']);
            if (!$linha['especie']) continue;
            $total++;
            $referencia = json_decode($linha['embedding'], true, 64, JSON_THROW_ON_ERROR);
            if (count($referencia) !== ANIMAL_DIMENSIONS) continue;
            $similaridade = 0.0;
            // Produto escalar de vetores normalizados equivale à similaridade cosseno.
            foreach ($vetor as $i => $valor) $similaridade += $valor * $referencia[$i];
            $similaridade = max(-1.0, min(1.0, $similaridade));
            $chave = $linha['animal_id'];
            // Referências legadas podem ter várias fotos: conserva só a mais próxima por referência.
            if (!isset($melhores[$chave]) || $similaridade > $melhores[$chave]['similarity']) {
                $melhores[$chave] = ['id' => (int)$linha['id'], 'animal_id' => (int)$chave,
                    'especie' => $linha['especie'], 'raca' => $linha['raca'], 'similarity' => $similaridade];
            }
        }
        usort($melhores, static fn($a, $b) => $b['similarity'] <=> $a['similarity']);
        $vizinhos = array_slice($melhores, 0, 3);
        $primeiro = $vizinhos[0] ?? null;
        // Um único exemplar só é aceito como referência muito próxima, nunca como certeza da raça.
        $concordam = isset($vizinhos[1]) && $vizinhos[1]['similarity'] >= 0.85
            && $vizinhos[1]['especie'] === $primeiro['especie'] && $vizinhos[1]['raca'] === $primeiro['raca'];
        $aceito = $primeiro && ($primeiro['similarity'] >= 0.97 || ($primeiro['similarity'] >= 0.85 && $concordam));
        if (!$administrador) {
            // A identificação pública recebe apenas rótulos/pontuações, não os IDs dos exemplos.
            foreach ($vizinhos as &$vizinho) { unset($vizinho['id'], $vizinho['animal_id']); }
            unset($vizinho);
            if ($primeiro) unset($primeiro['id'], $primeiro['animal_id']);
        }
        resposta(['match' => $aceito ? $primeiro : null, 'neighbors' => $vizinhos, 'total' => $total]);
    }
    if ($acao === 'save' && $metodo === 'POST') {
        // O formulário explícito de cadastro confirma os rótulos; inferências não são salvas sozinhas.
        if (($dados['confirmed'] ?? false) !== true) throw new InvalidArgumentException('Confirme os rótulos antes de salvar para aprendizado.');
        $codigo = strtoupper(animalText($dados, 'identificacao', 60, false));
        if ($codigo === '') $codigo = 'AUTO-' . strtoupper(bin2hex(random_bytes(12)));
        if (!preg_match('/^[A-Z0-9_-]{1,60}$/D', $codigo)) throw new InvalidArgumentException('Use letras, números, hífen ou sublinhado na identificação.');
        $especie = animalSpecies(animalText($dados, 'especie', 100));
        if (!$especie) throw new InvalidArgumentException('Selecione cachorro, gato, cavalo, bovino, ovelha, galinha, pato ou ganso.');
        $raca = animalText($dados, 'raca', 100, false) ?: 'Não identificada';
        $observacoes = animalText($dados, 'observacoes', 2000, false);
        $base64 = $dados['image'] ?? null;
        // Decodifica em modo estrito e verifica conteúdo, dimensões e limite, sem confiar na extensão.
        if (!is_string($base64) || !str_starts_with($base64, 'data:image/jpeg;base64,')) throw new InvalidArgumentException('Envie uma foto JPEG.');
        $foto = base64_decode(substr($base64, 23), true);
        $info = $foto === false ? false : @getimagesizefromstring($foto);
        if (!$info || strlen($foto) > 1048576 || $info[0] !== 512 || $info[1] !== 512 || $info['mime'] !== 'image/jpeg') {
            throw new InvalidArgumentException('A foto deve ser JPEG de 512 × 512, até 1 MB.');
        }
        $sugestao = $dados['suggestion'] ?? null;
        if ($sugestao !== null && (!is_array($sugestao) || strlen(json_encode($sugestao)) > 10000)) throw new InvalidArgumentException('Sugestão inválida.');
        // Animal + foto + vetor entram juntos; uma foto duplicada desfaz também a referência nova.
        $db->beginTransaction();
        // Uma correção da foto já cadastrada não deve ser bloqueada como simples duplicidade.
        // Fotos da própria sessão podem receber novo rótulo; registros alheios geram só sugestão pendente.
        if (($dados['correction'] ?? false) === true) {
            $consultaFoto = $db->prepare('SELECT s.id, s.animal_id, s.sugestao_original, a.especie, a.raca, a.observacoes
                FROM animal_ia.amostras s JOIN animal_ia.animais a ON a.id = s.animal_id
                WHERE s.foto_sha256 = ? AND s.extrator_versao = ? AND s.preprocessamento_versao = ? FOR UPDATE OF s');
            $consultaFoto->execute([hash('sha256',$foto),ANIMAL_EXTRACTOR,ANIMAL_PREPROCESS]);
            $fotoAnterior = $consultaFoto->fetch();
            if ($fotoAnterior) {
                $antes = ['especie'=>$fotoAnterior['especie'],'raca'=>$fotoAnterior['raca'],
                    'amostra_id'=>(int)$fotoAnterior['id'],
                    'animal_id_anterior'=>(int)$fotoAnterior['animal_id'],
                    'sugestao_original'=>$fotoAnterior['sugestao_original'] === null ? null : json_decode($fotoAnterior['sugestao_original'],true,64,JSON_THROW_ON_ERROR)];
                $propria = in_array((int)$fotoAnterior['id'],$enviadas,true);
                $depois = ['especie'=>$especie,'raca'=>$raca,'tipo'=>'correcao_publica',
                    'estado'=>$propria?'aplicada':'pendente'];
                $animalRevisao = $fotoAnterior['animal_id'];
                if ($propria) {
                    // Cria outra referência em vez de alterar o animal compartilhado da foto anterior.
                    // Assim, até uma foto anexada a um código legado não modifica outras fotos daquele código.
                    $novaReferencia = $db->prepare('INSERT INTO animal_ia.animais (identificacao,especie,raca,observacoes)
                        VALUES (?,?,?,?) RETURNING id');
                    $novaReferencia->execute(['AUTO-'.strtoupper(bin2hex(random_bytes(12))),$especie,$raca,$observacoes]);
                    $animalRevisao = $novaReferencia->fetchColumn();
                    $metadados = ['ia'=>$sugestao,'rotulos_informados'=>['especie'=>$especie,'raca'=>$raca],
                        'correcao_da_identificacao'=>true];
                    $db->prepare('UPDATE animal_ia.amostras SET animal_id = ?, sugestao_original = CAST(? AS jsonb) WHERE id = ?')
                        ->execute([$animalRevisao,json_encode($metadados,JSON_THROW_ON_ERROR),$fotoAnterior['id']]);
                }
                $db->prepare('INSERT INTO animal_ia.revisoes (animal_id,antes,depois,motivo)
                    VALUES (?,CAST(? AS jsonb),CAST(? AS jsonb),?)')
                    ->execute([$animalRevisao,json_encode($antes,JSON_THROW_ON_ERROR),json_encode($depois,JSON_THROW_ON_ERROR),
                        $propria?'Correção da identificação pelo visitante que enviou a foto.':'Sugestão pública de correção; cadastro anterior preservado.']);
                $db->commit();
                resposta(['id'=>(int)$fotoAnterior['id'],'pending_review'=>!$propria,'message'=>$propria
                    ?'Correção salva e aplicada ao seu exemplo.'
                    :'Correção recebida para revisão. O cadastro anterior foi preservado.']);
            }
        }
        $inserir = $db->prepare('INSERT INTO animal_ia.animais (identificacao, especie, raca, observacoes)
            VALUES (?, ?, ?, ?) ON CONFLICT (identificacao) DO NOTHING');
        $inserir->execute([$codigo, $especie, $raca, $observacoes]);
        $existente = $inserir->rowCount() === 0;
        $consulta = $db->prepare('SELECT * FROM animal_ia.animais WHERE identificacao = ? FOR UPDATE');
        $consulta->execute([$codigo]);
        $animal = $consulta->fetch();
        // Adiciona fotos ao animal existente sem sobrescrever sua classificação.
        $registroSugestao = ['ia' => $sugestao, 'rotulos_informados' => ['especie' => $especie, 'raca' => $raca],
            'animal_ja_existia' => $existente, 'correcao_da_identificacao'=>($dados['correction'] ?? false) === true];
        $inserir = $db->prepare('INSERT INTO animal_ia.amostras
            (animal_id, foto, foto_sha256, embedding, extrator_versao, preprocessamento_versao, sugestao_original, observacoes, confirmado)
            VALUES (?, decode(?, \'base64\'), ?, CAST(? AS real[]), ?, ?, CAST(? AS jsonb), ?, true) RETURNING id');
        $inserir->execute([$animal['id'], base64_encode($foto), hash('sha256', $foto),
            '{' . implode(',', $vetor) . '}', ANIMAL_EXTRACTOR, ANIMAL_PREPROCESS,
            json_encode($registroSugestao, JSON_THROW_ON_ERROR), $observacoes]);
        $id = $inserir->fetchColumn();
        $db->commit();
        // Limita os IDs guardados na sessão do servidor, sem remover amostras do banco.
        $_SESSION['amostras_enviadas'] = array_slice(array_values(array_unique([...$enviadas, (int)$id])), -500);
        resposta(['id' => (int)$id, 'existing_animal' => $existente, 'message' => $existente
            ? 'Nova foto e vetor salvos no PostgreSQL para o animal existente. Espécie e raça do cadastro anterior foram mantidas.'
            : 'Foto e vetor confirmados salvos no PostgreSQL.'], 201);
    }
    if ($acao === 'revise' && $metodo === 'POST') {
        // Corrigir dados antigos exige administração e preserva o antes/depois em uma transação.
        $id = filter_var($dados['animal_id'] ?? null, FILTER_VALIDATE_INT, ['options' => ['min_range' => 1]]);
        if (!$id) throw new InvalidArgumentException('Animal inválido.');
        $especie = animalText($dados, 'especie', 100);
        $raca = animalText($dados, 'raca', 100);
        $observacoes = animalText($dados, 'observacoes', 2000, false);
        $motivo = animalText($dados, 'motivo', 500);
        $db->beginTransaction();
        $consulta = $db->prepare('SELECT especie, raca, observacoes FROM animal_ia.animais WHERE id = ? FOR UPDATE');
        $consulta->execute([$id]);
        $antes = $consulta->fetch();
        if (!$antes) { $db->rollBack(); resposta(['error' => 'Animal não encontrado.'], 404); }
        $depois = ['especie' => $especie, 'raca' => $raca, 'observacoes' => $observacoes];
        $db->prepare('UPDATE animal_ia.animais SET especie = ?, raca = ?, observacoes = ?, atualizado_em = now() WHERE id = ?')
            ->execute([$especie, $raca, $observacoes, $id]);
        $db->prepare('INSERT INTO animal_ia.revisoes (animal_id, antes, depois, motivo) VALUES (?, CAST(? AS jsonb), CAST(? AS jsonb), ?)')
            ->execute([$id, json_encode($antes), json_encode($depois), $motivo]);
        $db->commit();
        resposta(['ok' => true, 'message' => 'Correção registrada e aplicada às fotos deste animal.']);
    }
    if ($acao === 'deactivate' && $metodo === 'POST') {
        // Retirada lógica: deixa de ensinar, mas os dados continuam disponíveis para auditoria/backup.
        $id = filter_var($dados['sample_id'] ?? null, FILTER_VALIDATE_INT, ['options' => ['min_range' => 1]]);
        if (!$id) throw new InvalidArgumentException('Amostra inválida.');
        $consulta = $db->prepare('UPDATE animal_ia.amostras SET ativo = false WHERE id = ? RETURNING id');
        $consulta->execute([$id]);
        if (!$consulta->fetchColumn()) resposta(['error' => 'Amostra não encontrada.'], 404);
        resposta(['ok' => true]);
    }
    resposta(['error' => 'Rota não encontrada.'], 404);
} catch (InvalidArgumentException | JsonException $erro) {
    // Erros de entrada podem ser mostrados ao cliente; transações incompletas são revertidas.
    if ($db?->inTransaction()) $db->rollBack();
    resposta(['error' => $erro->getMessage()], 422);
} catch (PDOException $erro) {
    // Não devolve SQL nem a mensagem bruta da conexão, que pode conter dados de infraestrutura.
    if ($db?->inTransaction()) $db->rollBack();
    if ($erro->getCode() === '23505') resposta(['error' => 'Esta foto já foi cadastrada. Use outra foto ou corrija o cadastro existente.'], 409);
    error_log('Animais IA: falha de banco, SQLSTATE ' . $erro->getCode());
    resposta(['error' => 'Banco indisponível. Confira a conexão, pdo_pgsql e execute a migração.'], 503);
} catch (Throwable $erro) {
    // Última proteção para falhas de instalação/configuração sem revelar arquivos privados.
    if ($db?->inTransaction()) $db->rollBack();
    error_log('Animais IA: falha interna do tipo ' . get_class($erro));
    resposta(['error' => 'Serviço não configurado ou indisponível. Confira a configuração da aplicação.'], 503);
}
