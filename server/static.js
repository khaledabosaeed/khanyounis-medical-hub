import express from 'express';

export function createStaticMiddleware(publicRoot) {
  return express.static(publicRoot, {
    index: false,
    fallthrough: true,
    maxAge: 0,
    setHeaders(res, filePath) {
      if (/\.[a-f0-9]{16}\.(?:js|css)$/.test(filePath)) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      } else if (/\.(?:js|css)$/.test(filePath)) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
      }
    },
  });
}
