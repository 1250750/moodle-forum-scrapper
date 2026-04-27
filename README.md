# Moodle Forum Q&A Scraper

Extensao Chrome/Brave Manifest V3 para organizar conteudo de foruns Moodle onde ja estas autenticado.

A extensao adiciona uma UI flutuante nas paginas Moodle de forum e discussao, extrai perguntas e respostas, e exporta os dados para JSON ou Markdown.

## Ficheiros

- `manifest.json`: configuracao da extensao MV3.
- `scraper-core.js`: logica de scraping, paginacao, AJAX Moodle e fallback DOM.
- `content.js`: UI flutuante, preview, downloads e clipboard.
- `panel.css`: estilos da UI.
- `README.md`: instrucoes de instalacao e uso.

## Instalacao no Chrome ou Brave

1. Abre `chrome://extensions`.
2. Ativa `Developer mode`.
3. Clica em `Load unpacked`.
4. Seleciona esta pasta do projeto.
5. Abre uma pagina Moodle onde ja tenhas sessao iniciada.

A extensao corre apenas nestas paginas:

- `*://*/mod/forum/view.php*`
- `*://*/mod/forum/discuss.php*`

## Uso

Quando abres uma pagina Moodle compativel, aparece um painel no canto inferior direito com o titulo `Moodle Scraper`.

Botoes:

- `Scrape forum`: extrai discussoes encontradas na pagina de forum e segue paginacao.
- `Scrape current discussion`: extrai apenas a discussao aberta.
- `Preview`: abre um modal com o resultado estruturado.
- `Download JSON`: descarrega o JSON final.
- `Download Markdown`: descarrega o Markdown final.
- `Copy JSON`: copia o JSON formatado para o clipboard.

O campo `Concorrencia` controla quantas discussoes sao processadas em paralelo. O valor por defeito e `3`.

## Output JSON

O JSON final e simples e nao inclui ids, HTML, URLs, timestamps, raw data, evidence ou logs.

```json
{
  "forum": "Nome do forum",
  "discussions": [
    {
      "title": "Titulo da discussao",
      "question": {
        "author": "Autor",
        "text": "Pergunta"
      },
      "answers": [
        {
          "author": "Autor",
          "text": "Resposta"
        }
      ]
    }
  ]
}
```

## Output Markdown

```md
# Nome do forum

## Titulo da discussao

**Pergunta - Autor**
Texto da pergunta

**Resposta - Autor**
Texto da resposta
```

## O que a extensao faz

- Deteta se a pagina atual e uma lista de forum ou uma discussao.
- Recolhe links de discussoes.
- Segue paginacao do forum.
- Tenta usar AJAX JSON do Moodle quando existe `sesskey`.
- Usa fallback por DOM quando AJAX falha.
- Expande respostas visiveis na discussao atual quando encontra botoes de expandir.
- Normaliza whitespace.
- Usa retries em pedidos HTTP.
- Apanha erros por discussao sem parar o scraping completo.

## Seguranca e privacidade

- Nao pede login.
- Nao pede password.
- Nao contorna autenticacao.
- Usa apenas a sessao Moodle ja aberta no browser.
- Le apenas conteudo acessivel na pagina atual ou em paginas do mesmo forum navegadas pela tua sessao.
- Nao envia dados para servidores externos.
- Os dados ficam locais ate copiares ou descarregares.

## Limites conhecidos

Moodle varia entre versoes, temas e configuracoes. A extensao cobre seletores e endpoints comuns, mas foruns muito personalizados podem precisar de ajustes.

Se o Moodle nao expuser `sesskey` ou bloquear endpoints AJAX, a extensao usa fallback por DOM. Nesse caso, pode extrair menos dados dependendo do HTML disponivel.
