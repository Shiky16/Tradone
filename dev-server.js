// Local-dev convenience only — serves this directory's static files (the
// PWA shell) over http:// so IndexedDB/Web Crypto behave consistently and
// (once added) the service worker has a real origin to register against.
// Not part of the deployed app: in production the shell is served by a
// static host (GitHub Pages/Netlify/Cloudflare Pages/etc.) and the relay in
// server.js is deployed separately — see the plan doc for why.
const express = require('express');
const path = require('path');

const app = express();
app.use(express.static(__dirname));
const PORT = process.env.PORT || 8080;
app.listen(PORT, '127.0.0.1', () => {
  console.log(`Dev static server → http://localhost:${PORT}`);
});
