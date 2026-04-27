# Moodle Forum Q&A Scraper

Userscript Tampermonkey para extrair perguntas e respostas de foruns Moodle usando a sessao ja autenticada do browser.

Nao pede username/password, nao envia dados para servidores externos e corre localmente dentro da pagina Moodle.

## Ficheiro principal

- `moodle-forum-qa-scraper.user.js`

## Instalacao

1. Instala a extensao Tampermonkey no Brave ou Chrome.
2. Abre o dashboard do Tampermonkey.
3. Cria um novo script.
4. Cola o conteudo completo de `moodle-forum-qa-scraper.user.js`.
5. Guarda o script.
6. Abre uma pagina Moodle ja autenticada em:
- `/mod/forum/view.php`
- `/mod/forum/discuss.php`

## Uso

Ao abrir uma pagina compativel, aparece uma UI flutuante no canto inferior direito com o titulo `Moodle Scraper`.

Botoes disponiveis:

- `Scrape forum`: extrai todas as discussoes encontradas na pagina de forum, incluindo paginacao.
- `Scrape current discussion`: extrai apenas a discussao aberta.
- `Preview`: mostra uma pre-visualizacao dentro da pagina.
- `Download JSON`: descarrega o resultado em JSON.
- `Download Markdown`: descarrega o resultado em Markdown.
- `Copy JSON`: copia o JSON formatado para o clipboard.

A UI mostra:

- numero de discussoes encontradas;
- discussao atual;
- numero de posts extraidos;
- numero de erros;
- estado final;
- logs curtos de execucao.

## Output JSON

O JSON exportado e simples e nao inclui metadata tecnica, URLs, IDs, HTML bruto, logs ou timestamps.

Formato:

```json
{
  "forum": "Nome do forum",
  "discussions": [
    {
      "title": "Titulo da discussao",
      "question": {
        "author": "Nome do autor",
        "text": "Texto da pergunta"
      },
      "answers": [
        {
          "author": "Nome do autor",
          "text": "Texto da resposta"
        }
      ]
    }
  ]
}
```

## Output Markdown

Formato:

```md
# Nome do forum

## Titulo da discussao

**Pergunta - Autor**
Texto da pergunta

**Resposta - Autor**
Texto da resposta
```

## Como funciona

O script tenta extrair posts por AJAX JSON do Moodle quando possivel. Se isso falhar, usa fallback por DOM da pagina.

Tambem suporta:

- detecao automatica entre pagina de forum e pagina de discussao;
- recolha de links de discussoes;
- paginacao do forum;
- expansao de respostas visiveis;
- normalizacao de whitespace;
- retry automatico em pedidos;
- pequeno delay entre pedidos;
- concorrencia configuravel, por defeito `3`;
- erro por discussao sem parar o scraping completo.

## Seguranca e privacidade

- Nao pede credenciais.
- Nao guarda passwords.
- Usa apenas cookies/sessao ja existentes no browser.
- Nao envia dados para APIs externas.
- O resultado fica local no browser ate copiares ou descarregares.

## Limitacoes

Moodle pode variar muito entre versoes, temas e configuracoes. O script cobre seletores e endpoints comuns, mas alguns foruns personalizados podem precisar de ajustes.

Se o Moodle bloquear AJAX ou se a estrutura HTML for muito diferente, o fallback por DOM pode extrair menos dados.
