'use strict';

const { AppError } = require('./core.cjs');

// Only the main process can issue authenticated requests. No credentials cross IPC.
function createSteamRequest(net, session) {
  return ({ path, method = 'GET', form, timeoutMs = 30000, referer = '/market/' }) => new Promise((resolve, reject) => {
    const origin = 'https://steamcommunity.com';
    const url = new URL(path, origin);
    const ref = new URL(referer, origin);
    if (url.origin !== origin || ref.origin !== origin || !['GET', 'POST'].includes(method)) {
      reject(new AppError('validation', '请求地址无效。'));
      return;
    }
    const mutation = method === 'POST';
    let settled = false;
    let timer;
    let request;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(result);
    };
    const interrupted = () => new AppError(mutation ? 'uncertain' : 'network', mutation
      ? '连接中断，提交结果未知。请先在 Steam 核对，勿直接重试。'
      : '无法连接 Steam，请检查网络后重试。');
    try {
      request = net.request({ url: url.href, method, session, credentials: 'include', redirect: 'manual', cache: 'no-store' });
      request.setHeader('Accept', 'application/json,text/html;q=0.9,*/*;q=0.8');
      request.setHeader('Accept-Language', 'zh-CN,zh;q=0.9,en;q=0.7');
      request.setHeader('Referer', ref.href);
      if (mutation) {
        request.setHeader('Origin', origin);
        request.setHeader('Content-Type', 'application/x-www-form-urlencoded; charset=UTF-8');
      }
      request.on('redirect', (_status, _method, redirectUrl) => {
        const login = /\/login\b|login\.steampowered\.com/.test(redirectUrl);
        finish(new AppError(mutation ? 'uncertain' : login ? 'auth' : 'schema', mutation
          ? 'Steam 返回了重定向，提交结果未知。请在 Steam 核对后再继续。'
          : login ? 'Steam 登录已失效，请重新登录。' : 'Steam 页面发生跳转，请刷新或重新登录。'));
        request.abort();
      });
      request.on('response', (response) => {
        const chunks = [];
        let bytes = 0;
        response.on('data', (chunk) => {
          bytes += chunk.length;
          if (bytes > 32 * 1024 * 1024) {
            finish(new AppError(mutation ? 'uncertain' : 'schema', 'Steam 响应过大，请减少库存范围。'));
            request.abort();
          } else chunks.push(chunk);
        });
        response.on('end', () => finish(null, { status: response.statusCode, body: Buffer.concat(chunks).toString('utf8'), url: url.href, headers: response.headers }));
        response.on('error', () => finish(interrupted()));
        response.on('aborted', () => finish(interrupted()));
      });
      request.on('error', () => finish(interrupted()));
      request.on('abort', () => finish(interrupted()));
      timer = setTimeout(() => {
        finish(new AppError(mutation ? 'uncertain' : 'network', mutation
          ? '提交超时，结果未知。请先在 Steam 核对本项，勿直接重试。'
          : 'Steam 响应超时，请稍后重试。'));
        request.abort();
      }, Math.max(1000, Math.min(timeoutMs, 90000)));
      if (form) request.write(new URLSearchParams(form).toString());
      request.end();
    } catch (_) {
      finish(interrupted());
      if (request) request.abort();
    }
  });
}

module.exports = { createSteamRequest };
