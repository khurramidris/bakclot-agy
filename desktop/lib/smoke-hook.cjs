// Used when BACKLOT_SMOKE is set (see scripts/smoke.cjs): runs the whole app in demo mode with no one clicking,
// makes a whole film and checks the result. Exits 0 on success.

exports.run = async ({ app, settings, boot, stack, getMain, logFn }) => {
  const fail = (m) => { console.log(`SMOKE FAIL: ${m}`); app.exit(1); };
  const say = (m) => console.log('SMOKE step: ' + m);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    // Demo mode: start everything and open the app.
    settings.save({ mode: 'demo' });
    say('booting');
    const r = await boot();
    say('booted');
    const win = getMain();
    await new Promise((res) => (win.webContents.isLoading() ? win.webContents.once('did-finish-load', res) : res()));
    await wait(2500);
    const me = await fetch(`${r.url}/v1/me`, { headers: { authorization: 'Bearer dev:11111111-2222-3333-4444-555555555555' } }).then((x) => x.status);
    const title = win.getTitle();
    console.log(`SMOKE app at ${r.url}, /v1/me -> ${me}, window title "${title}"`);
    if (me >= 500) return fail(`/v1/me answered ${me}`);
    // 3. A whole film, prompt to MP4, with the bundled database, FFmpeg and font (demo mode: fake model, real editing).
    const headers = { authorization: 'Bearer dev:11111111-2222-3333-4444-555555555555', 'content-type': 'application/json' };
    const call = async (method, path, body) => {
      const x = await fetch(`${r.url}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
      const j = await x.json().catch(() => ({}));
      if (!x.ok) throw new Error(`${method} ${path} -> ${x.status} ${JSON.stringify(j).slice(0, 200)}`);
      return j;
    };
    const until = async (id, stage) => {
      for (let i = 0; i < 240; i++) {
        const d = await call('GET', `/v1/projects/${id}`);
        if (d.project.stage === stage) return d;
        if (d.project.stage === 'failed') throw new Error(`project failed: ${JSON.stringify(d.project.error || d.project).slice(0, 200)}`);
        await wait(500);
      }
      throw new Error(`timed out waiting for stage ${stage}`);
    };
    const { project } = await call('POST', '/v1/create', { prompt: 'A night-shift nurse finds a letter that proves her husband is alive.', format: 'microdrama' });
    await until(project.id, 'ready');
    say('story written and shots planned');
    await call('POST', `/v1/projects/${project.id}/produce`, {});
    const done = await until(project.id, 'done');
    const cut = done.latest_cuts[0];
    const video = await fetch(cut.url.startsWith('http') ? cut.url : `${r.url}${cut.url}`);
    const bytes = (await video.arrayBuffer()).byteLength;
    console.log(`SMOKE film: ${cut.kind} cut, ${bytes} bytes, ${video.headers.get('content-type')}`);
    if (!video.ok || bytes < 10_000) return fail('the finished film is missing or empty');
    console.log('SMOKE OK');
    app.quit();
  } catch (e) { logFn('smoke', e?.stack || String(e)); fail(e?.message || String(e)); }
};

