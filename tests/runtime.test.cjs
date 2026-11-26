/* Execute the real browser scripts with a minimal DOM/Canvas adapter.
   This catches runtime wiring errors, but is not a substitute for visual browser tests. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.resolve(__dirname, '..');

function boot() {
    const callbacks = new Map(), timeouts = [];
    const context2d = new Proxy({}, { get(_, key) {
        if (key === 'createLinearGradient' || key === 'createRadialGradient') return () => ({ addColorStop() {} });
        if (key === 'measureText') return () => ({ width: 100 });
        return () => {};
    }, set() { return true; } });
    const elements = new Map();
    for (const [, id] of fs.readFileSync(path.join(root, 'index.html'), 'utf8').matchAll(/id="([^"]+)"/g)) {
        const el = { style: {}, value: id === 'volumeSlider' ? '1' : '', classList: { add() {}, remove() {}, toggle() {} },
            width: 1920, height: 1080, getContext: () => context2d,
            getBoundingClientRect: () => ({ left: 0, top: 0, width: 1920, height: 1080 }),
            addEventListener: (name, fn) => callbacks.set(id + ':' + name, fn),
            play: () => Promise.reject(new Error('Missing test audio')), pause() {}, focus() {} };
        elements.set(id, el);
    }
    const param = { setValueAtTime() {}, exponentialRampToValueAtTime() {}, value: 1 };
    const audioNode = { connect() {}, start() {}, stop() {}, frequency: param, gain: param, Q: param };
    class AudioContext {
        currentTime = 0; sampleRate = 1000; destination = {};
        createGain() { return audioNode; } createOscillator() { return audioNode; }
        createBiquadFilter() { return audioNode; } createBufferSource() { return { ...audioNode }; }
        createWaveShaper() { return { ...audioNode }; }
        createBuffer() { return { getChannelData: () => new Float32Array(1000) }; }
    }
    const document = { hidden: false,
        getElementById: id => { assert.ok(elements.has(id), 'missing DOM element: ' + id); return elements.get(id); },
        querySelectorAll: () => [], querySelector: () => null,
        addEventListener: (name, fn) => callbacks.set('document:' + name, fn) };
    const window = { innerWidth: 1920, innerHeight: 1080, devicePixelRatio: 1, AudioContext,
        matchMedia: () => ({ matches: false }),
        addEventListener: (name, fn) => callbacks.set('window:' + name, fn) };
    const context = vm.createContext({ document, window, console, CanvasRenderingContext2D: function () {},
        setTimeout: callback => { timeouts.push(callback); return timeouts.length; }, clearTimeout() {}, setInterval: () => 1, clearInterval() {}, requestAnimationFrame() {} });
    for (const file of ['world.js', 'levels.js', 'effects.js', 'game.js']) {
        vm.runInContext(fs.readFileSync(path.join(root, 'src', file), 'utf8'), context, { filename: file });
    }
    const run = code => vm.runInContext(code, context);
    run('musicEnabled = false');
    window.onload(); // Audio rejection must be handled rather than becoming unhandled.
    return { run, callbacks, elements, timeouts };
}

test('every campaign level and retained character initializes, updates, draws and restarts', () => {
    const { run } = boot();
    for (const character of ['standard', 'tank', 'ammo', 'machete_char', 'pyro']) {
        for (let level = 0; level <= 5; level++) {
            run(`selectedCharacter = '${character}'; startGame(${level}); update(); draw();`);
            assert.equal(run('currentLevel'), level);
            assert.ok(run('player.hp > 0 && navigation.connected'));
            const before = run('JSON.stringify({obstacles, enemies: enemies.map(e => [e.x,e.y,e.type]), pickups:weaponPickups})');
            // Re-initialize immediately, without simulating movement, to compare starting state.
            run('initLevel(currentLevel)');
            const initial = run('JSON.stringify({obstacles, enemies: enemies.map(e => [e.x,e.y,e.type]), pickups:weaponPickups})');
            run('restartLevel()');
            assert.equal(run('JSON.stringify({obstacles, enemies: enemies.map(e => [e.x,e.y,e.type]), pickups:weaponPickups})'), initial);
            assert.ok(before.length > 0);
            assert.ok(run('enemies.every(e => !checkWallCollision(e.x,e.y,e.radius))'));
            run('backToMainMenuFromGame()');
        }
    }
    assert.throws(() => run('startGame(101)'), /Unknown campaign level/);
    assert.equal(run('typeof selectChapter2Level'), 'undefined');
});

test('ballistic hits, walls, piercing, training and boss damage share the actual collision pipeline', () => {
    const { run } = boot();
    run(`startGame(1); walls=[]; enemies=[createEnemy(200,150,'melee',1)];
        bullets=[{x:100,y:150,speedX:200,speedY:0,radius:5,damage:25,color:'#fff'}]; updatePlayerProjectiles();`);
    assert.equal(run('enemies[0].hp'), 30);
    assert.equal(run('bullets.length'), 0);
    assert.ok(run('combatEffects.particles.length > 0 && combatEffects.traces.length > 0'));
    run(`walls=[{x:150,y:0,width:5,height:300}];
        bullets=[{x:100,y:150,speedX:200,speedY:0,radius:5,damage:25,color:'#fff'}]; updatePlayerProjectiles();`);
    assert.equal(run('enemies[0].hp'), 30);
    run(`walls=[]; enemies=[createEnemy(200,150,'melee',1),createEnemy(240,150,'melee',1)];
        bullets=[{x:100,y:150,speedX:200,speedY:0,radius:5,damage:25,pierce:1,color:'#fff'}]; updatePlayerProjectiles();`);
    assert.ok(run('enemies.every(e => e.hp===30)'));
    run(`startGame(0); walls=[]; tutorialTargets=[{x:200,y:150,radius:25,hp:25,hit:false}];
        bullets=[{x:100,y:150,speedX:200,speedY:0,radius:5,damage:25,color:'#fff'}]; updatePlayerProjectiles();`);
    assert.equal(run('tutorialTargets[0].hit'), true);
    run(`startGame(5); walls=[]; boss.x=200;boss.y=150;
        bullets=[{x:100,y:150,speedX:200,speedY:0,radius:5,damage:25,color:'#fff'}]; updatePlayerProjectiles();`);
    assert.equal(run('boss.hp'), 1975);
});

test('pause freezes cooldown/effects; reset clears effects and right click never fires', () => {
    const { run, callbacks } = boot();
    run('startGame(1); mouse.worldX=1000;mouse.worldY=150; shoot(); update();');
    assert.ok(run('combatEffects.traces.length > 0'));
    callbacks.get('gameCanvas:mousedown')({ button: 2 });
    assert.equal(run('mouse.clicked'), false);
    run('pauseGame()'); const cooldown = run('shootCooldown'); const traces = run('JSON.stringify(combatEffects.traces)');
    run('update(); draw()');
    assert.equal(run('shootCooldown'), cooldown); assert.equal(run('JSON.stringify(combatEffects.traces)'), traces);
    run('resumeGame(); mouse.clicked=true; keys.w=true');
    callbacks.get('window:blur')();
    assert.ok(run("!mouse.clicked && !keys.w && gameState === 'paused'"));
    run('restartLevel()');
    assert.ok(run('canShoot && combatEffects.traces.length===0 && combatEffects.particles.length===0'));
});

test('leaving HARD-MODE resets mode and simulation kills do not complete twice', () => {
    const { run } = boot();
    run('startHardMode(); backToLevelSelect()'); assert.equal(run('hardMode'), false);
    run('startHardMode(); startGame(1); exitToMenu()'); assert.equal(run('hardMode'), false);
    run('startGame(4); enemies=[]; update()'); assert.ok(run('miniBoss !== null && totalEnemies===21'));
    run(`miniBoss.hp=1; miniBoss.x=200;miniBoss.y=150; walls=[];
        bullets=[{x:100,y:150,speedX:200,speedY:0,radius:5,damage:25,color:'#fff'}]; updatePlayerProjectiles();`);
    assert.equal(run('miniBoss'), null); assert.equal(run('gameState'), 'complete');
});

test('combat timers freeze with pause and old callbacks cannot mutate a new session', () => {
    const { run, timeouts } = boot();
    run('startGame(1); globalThis.fired=0; afterCombat(()=>fired++,100); pauseGame();');
    run('for(let i=0;i<12;i++) update()'); assert.equal(run('fired'), 0);
    run('resumeGame(); for(let i=0;i<7;i++) update()'); assert.equal(run('fired'), 1);
    run('afterCombat(()=>fired++,100); restartLevel(); for(let i=0;i<7;i++) update()');
    assert.equal(run('fired'), 1);
    run('afterSession(()=>fired++,10)'); const stale = timeouts.at(-1);
    run('restartLevel()'); stale(); assert.equal(run('fired'), 1);
});

test('all retained weapons render and attack without chapter-specific dependencies', () => {
    const { run } = boot();
    run('startGame(1); mouse.worldX=800; mouse.worldY=150;');
    for (const type of ['pistol', 'shotgun', 'rifle', 'smg', 'sniper', 'machete', 'flamethrower']) {
        run(`equipWeapon('${type}'); canShoot=true; shoot(); update(); draw();`);
        assert.equal(run('player.weapon'), type);
    }
});
