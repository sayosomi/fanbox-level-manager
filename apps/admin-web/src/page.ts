export const ADMIN_CONTENT_SECURITY_POLICY =
  "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'";

export const ADMIN_PAGE = `<!doctype html>
<html lang="ja">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>FANBOX抽選レベル管理</title>
    <link rel="stylesheet" href="/style.css">
  </head>
  <body>
    <main>
      <h1>FANBOX抽選レベル管理</h1>
      <p id="status" role="status">ローカル管理アプリケーションは起動しています。</p>
    </main>
    <script src="/app.js" defer></script>
  </body>
</html>
`;

export const ADMIN_SCRIPT = `document.documentElement.dataset.adminReady = "true";
`;

export const ADMIN_STYLES = `:root {
  color-scheme: light;
  font-family: -apple-system, BlinkMacSystemFont, "Hiragino Sans", "Yu Gothic", sans-serif;
  color: #252525;
  background: #f4f5f7;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  min-width: 320px;
}

main {
  width: min(100% - 2rem, 56rem);
  margin: 0 auto;
  padding: clamp(2rem, 8vw, 6rem) 0;
}

h1 {
  margin: 0;
  font-size: clamp(1.6rem, 3vw, 2.4rem);
  line-height: 1.3;
}

#status {
  margin: 1.5rem 0 0;
  padding: 1rem 1.25rem;
  border: 1px solid #cfd4dc;
  border-radius: 0.5rem;
  background: #ffffff;
}
`;
