# Gestão de materiais Coord Lincoln

Painel de registro de fornecimento de materiais, preparado para Railway e PostgreSQL.

As credenciais, os dados dos técnicos e os registros não ficam neste repositório público.

## Variáveis privadas

- `DATABASE_URL`: conexão PostgreSQL fornecida pelo Railway.
- `SESSION_SECRET`: chave longa e aleatória.
- `INITIAL_USERS_JSON`: usuários iniciais com nome, login e senha.
- `TECHNICIANS_JSON`: técnicos autorizados para pesquisa por matrícula SAP.

