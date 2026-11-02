<?php
// Copie para C:/erpia/config/animais-ia.php. Nunca salve a senha na pasta web.
return [
    // Conexão local entre a aplicação e o PostgreSQL da mesma VPS; não precisa expor a porta na internet.
    'dsn' => 'pgsql:host=127.0.0.1;port=5432;dbname=animais_ia;connect_timeout=5',
    // Usuário exclusivo do projeto. Esta senha é a do PostgreSQL, não a de administração da API.
    'user' => 'animais_app',
    'password' => 'PREENCHA_SOMENTE_NO_SERVIDOR',
    // Opcional, somente para administrar fotos antigas e corrigir cadastros:
    // 'admin_password_hash' => 'HASH_GERADO_POR_password_hash',
];
