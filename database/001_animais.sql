-- Migração inicial transacional. IF NOT EXISTS permite repetir esta instalação inicial;
-- não substitui migrações de evolução caso uma estrutura existente precise de novas colunas.
BEGIN;
-- Schema exclusivo do projeto, sem alterar tabelas de outros módulos do ERP.
CREATE SCHEMA IF NOT EXISTS animal_ia;

-- Referência interna e rótulos confirmados. AUTO-* é gerado no PHP, não preenchido pelo visitante.
CREATE TABLE IF NOT EXISTS animal_ia.animais (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    identificacao VARCHAR(60) NOT NULL UNIQUE,
    especie VARCHAR(100) NOT NULL CHECK (length(trim(especie)) > 0),
    raca VARCHAR(100) NOT NULL CHECK (length(trim(raca)) > 0),
    observacoes TEXT NOT NULL DEFAULT '',
    criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
    atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Cada exemplo mantém foto, vetor e metadados juntos para backup e reprocessamento futuro.
CREATE TABLE IF NOT EXISTS animal_ia.amostras (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    animal_id BIGINT NOT NULL REFERENCES animal_ia.animais(id),
    foto BYTEA NOT NULL CHECK (octet_length(foto) BETWEEN 1 AND 1048576),
    foto_sha256 CHAR(64) NOT NULL,
    -- Vetor normalizado pela API; REAL[] é nativo e não exige a extensão pgvector.
    embedding REAL[] NOT NULL,
    extrator_versao VARCHAR(100) NOT NULL,
    preprocessamento_versao VARCHAR(80) NOT NULL,
    -- A sugestão e os rótulos informados ficam separados do cadastro confirmado usado na busca.
    sugestao_original JSONB,
    observacoes TEXT NOT NULL DEFAULT '',
    confirmado BOOLEAN NOT NULL DEFAULT false,
    ativo BOOLEAN NOT NULL DEFAULT true,
    criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Garante uma dimensão com 1280 componentes não nulos; a API também valida finitude e norma.
    CONSTRAINT embedding_formato CHECK (
        array_ndims(embedding) = 1 AND array_lower(embedding, 1) = 1
        AND cardinality(embedding) = 1280 AND array_position(embedding, NULL) IS NULL
    ),
    -- A mesma imagem não é repetida para a mesma versão do extrator/preparação.
    CONSTRAINT foto_unica UNIQUE (foto_sha256, extrator_versao, preprocessamento_versao)
);
-- Índice de filtragem das amostras elegíveis; não é índice de distância vetorial.
CREATE INDEX IF NOT EXISTS amostras_aprendizado_idx
    ON animal_ia.amostras (extrator_versao, preprocessamento_versao, animal_id)
    WHERE confirmado AND ativo;

-- Histórico administrativo: corrigir um animal conserva os rótulos anteriores e o motivo.
CREATE TABLE IF NOT EXISTS animal_ia.revisoes (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    animal_id BIGINT NOT NULL REFERENCES animal_ia.animais(id),
    antes JSONB NOT NULL,
    depois JSONB NOT NULL,
    motivo VARCHAR(500) NOT NULL,
    criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMIT;
