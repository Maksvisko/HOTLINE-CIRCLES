
        const canvas = document.getElementById('gameCanvas');
        const ctx = canvas.getContext('2d');
        // roundRect polyfill (Safari/older)
        if (!CanvasRenderingContext2D.prototype.roundRect) {
            CanvasRenderingContext2D.prototype.roundRect = function (x, y, w, h, r) {
                const rr = typeof r === 'number' ? { tl: r, tr: r, br: r, bl: r } : { tl: 0, tr: 0, br: 0, bl: 0, ...r };
                this.beginPath();
                this.moveTo(x + rr.tl, y);
                this.lineTo(x + w - rr.tr, y);
                this.quadraticCurveTo(x + w, y, x + w, y + rr.tr);
                this.lineTo(x + w, y + h - rr.br);
                this.quadraticCurveTo(x + w, y + h, x + w - rr.br, y + h);
                this.lineTo(x + rr.bl, y + h);
                this.quadraticCurveTo(x, y + h, x, y + h - rr.bl);
                this.lineTo(x, y + rr.tl);
                this.quadraticCurveTo(x, y, x + rr.tl, y);
                return this;
            };
        }
        const WORLD_WIDTH = 3600, WORLD_HEIGHT = 2200;
        let levelSeed = 1, levelRandom = GameWorld.seeded(1), navigation = null, navigationWallCount = -1;
        let shootCooldown = 0, simulationTime = 0, sessionToken = 0, combatTimers = [];
        function afterCombat(callback, delay) { combatTimers.push({ callback, frames: Math.max(1, Math.ceil(delay * 60 / 1000)) }); }
        function afterSession(callback, delay) {
            const token = sessionToken;
            setTimeout(() => { if (sessionToken === token) callback(); }, delay);
        }
        const combatEffects = CombatEffects.create();
        const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
        function ensureNavigation() {
            if (!navigation || navigationWallCount !== walls.length) {
                navigation = GameWorld.navigation(WORLD_WIDTH, WORLD_HEIGHT, walls);
                navigationWallCount = walls.length;
            }
        }
        canvas.width = 1920; canvas.height = 1080;

        let gameState = 'menu', currentLevel = 1, selectedLevel = 1, kills = 0, totalEnemies = 0, weaponSpawnTimer = 0, selectedCharacter = 'standard';
        let hardMode = false, hardModeProgress = 1, medkitUsed = false;

        const camera = { x: 0, y: 0, shakeX: 0, shakeY: 0, shakeDuration: 0, shakePower: 10 };
        const player = { x: 100, y: 100, radius: 15, speed: 7, hp: 100, maxHP: 100, color: '#ff0000', weapon: 'pistol', startingWeapon: 'pistol', hasTopLine: false, lastHpThreshold: 100 };

        let currentLanguage = 'ru';

        const weapons = {
            pistol: { name: 'Пистолет', damage: 25, fireRate: 300, ammo: Infinity, bulletSpeed: 10, color: '#ffff00', sound: 'pew', type: 'ranged' },
            shotgun: { name: 'Дробовик', damage: 25, fireRate: 700, ammo: 12, bulletSpeed: 11, color: '#ff8800', spread: 5, sound: 'boom', type: 'ranged' },
            rifle: { name: 'Винтовка', damage: 25, fireRate: 120, ammo: 45, bulletSpeed: 15, color: '#00ffff', sound: 'tak', type: 'ranged' },
            smg: { name: 'SMG', damage: 10, fireRate: 80, ammo: 100, bulletSpeed: 12, color: '#00ff00', sound: 'brr', type: 'ranged' },
            sniper: { name: 'Снайперка', damage: 100, fireRate: 3000, ammo: 8, bulletSpeed: 25, color: '#ff00ff', sound: 'snipe', type: 'ranged' },
            machete: { name: 'Рубака', damage: 40, fireRate: 400, ammo: Infinity, range: 80, color: '#9933FF', sound: 'slice', type: 'melee' },

            // Damage per 50ms tick; fuel is consumed once every three ticks.
            flamethrower: { name: 'Огнемет', damage: 1.5, fireRate: 50, ammo: 100, range: 320, cone: 0.55, consumeEvery: 3, color: '#ff7a00', sound: 'flame', type: 'flame' }
        };

        let currentWeapon = weapons.pistol, canShoot = true, macheteSlash = null;
        let abilityAvailable = true, abilityActive = false, abilityTimer = 0, originalFireRate = 0, originalMacheteRange = 80;

        // Per-run weapon state (ammo etc.) so switching doesn't reset to defaults
        let playerWeaponsState = {}; // { weaponType: { ...weaponData, ammo, _consumeAcc? } }
        function ensureWeaponState(type) {
            if (!playerWeaponsState[type]) {
                // clone from base weapons definition
                playerWeaponsState[type] = { ...weapons[type] };
            }
            return playerWeaponsState[type];
        }
        function equipWeapon(type) {
            // save current state back (currentWeapon is already a reference-like object)
            if (player.weapon && currentWeapon) {
                playerWeaponsState[player.weapon] = { ...currentWeapon };
            }
            player.weapon = type;
            currentWeapon = { ...ensureWeaponState(type) };
            updateHUD();
        }
        let enemies = [], bullets = [], enemyBullets = [], weaponPickups = [], walls = [], obstacles = [], boss = null, miniBoss = null, mainEnemiesDefeated = false;
        let enemyIdCounter = 1;
        let graffiti = [];

        // Flamethrower fuel pickups (spawn when flamethrower hits 0)
        let flameFuelPickups = []; // { x,y,radius, amount }
        let flameFuelSpawnedThisZero = false;

        // Flamethrower visuals
        let flameParticles = [];
        let flameHeat = []; // lingering heat spots (visual only)
        let flameAimAngle = 0;

        // Pyro ability: fire aura circle
        let pyroAura = {
            active: false,
            radius: 160,
            dps: 18,           // damage per second to enemies in circle
            ammoPerSec: 10,    // flamethrower fuel regen per second
            t: 0,
            tickAcc: 0
        };

        // Simple muzzle flashes (visual only)
        let muzzleFlashes = []; // {x,y,life,maxLife,angle}

        let levelTheme = { floorA: '#1a1a1a', floorB: '#141414', grid: '#2a2a2a', ambient: null };
        let tutorialStage = 0, tutorialTargets = [];
        let pyroTutorialStartAmmo = null;

        function updateFlame() {
            if (flameParticles.length) {
                for (let i = flameParticles.length - 1; i >= 0; i--) {
                    const p = flameParticles[i];
                    p.x += p.vx;
                    p.y += p.vy;
                    // light drag + upward lick
                    p.vx *= 0.94;
                    p.vy *= 0.94;
                    p.vy -= 0.03;
                    p.life--;
                    p.r *= 0.97;
                    if (p.life <= 0 || p.r < 0.8) flameParticles.splice(i, 1);
                }
            }

            if (flameHeat.length) {
                for (let i = flameHeat.length - 1; i >= 0; i--) {
                    const h = flameHeat[i];
                    h.life--;
                    h.r *= 0.985;
                    if (h.life <= 0 || h.r < 6) flameHeat.splice(i, 1);
                }
            }
        }

        function drawFlame() {
            // Draw heat first (below particles)
            if (flameHeat.length) {
                ctx.save();
                ctx.globalCompositeOperation = 'source-over';
                for (const h of flameHeat) {
                    const a = Math.max(0, Math.min(1, h.life / h.maxLife));
                    const g = ctx.createRadialGradient(h.x, h.y, 0, h.x, h.y, h.r);
                    g.addColorStop(0, `rgba(255, 180, 70, ${0.12 * a})`);
                    g.addColorStop(0.45, `rgba(255, 80, 0, ${0.09 * a})`);
                    g.addColorStop(1, 'rgba(255, 0, 0, 0)');
                    ctx.fillStyle = g;
                    ctx.beginPath();
                    ctx.arc(h.x, h.y, h.r, 0, Math.PI * 2);
                    ctx.fill();
                }
                ctx.restore();
            }

            if (!flameParticles.length) return;

            ctx.save();
            // Soft additive look but cheap: use lighter only for a few particles (still ok in 2D canvas)
            ctx.globalCompositeOperation = 'lighter';

            for (const p of flameParticles) {
                const a = Math.max(0, Math.min(1, p.life / p.maxLife));
                const outer = p.r * 1.6;
                const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, outer);
                g.addColorStop(0, `rgba(255, 255, 220, ${0.22 * a})`);
                g.addColorStop(0.25, `rgba(255, 190, 70, ${0.25 * a})`);
                g.addColorStop(0.6, `rgba(255, 90, 0, ${0.17 * a})`);
                g.addColorStop(1, 'rgba(120, 0, 0, 0)');
                ctx.fillStyle = g;
                ctx.beginPath();
                ctx.arc(p.x, p.y, outer, 0, Math.PI * 2);
                ctx.fill();
            }

            ctx.restore();
        }
        const tutorialTextElement = document.getElementById('tutorialText');
        const keys = {}, mouse = { x: 0, y: 0, worldX: 0, worldY: 0, clicked: false };
        let audioContext, musicEnabled = true, musicIntervals = [], masterGain = null;
        const menuMusic = document.getElementById('menuMusic');
        const level1Music = document.getElementById('level1Music');
        const level2Music = document.getElementById('level2Music');
        const level3Music = document.getElementById('level3Music');
        const level4Music = document.getElementById('level4Music');
        const bossMusic = document.getElementById('bossMusic');
        let menuMusicStarted = false;
        function safePlay(audio) {
            if (!audio || audio.error) return;
            try {
                const playback = audio.play();
                if (playback && playback.catch) playback.catch(() => {});
            } catch (_) { /* Missing track / unsupported media must not break a session. */ }
        }
        document.addEventListener('pointerdown', () => {
            if (gameState === 'menu' && musicEnabled) safePlay(menuMusic);
        }, { once: true });

        const gameDialog = document.getElementById('gameDialog');
        const gameDialogTitle = document.getElementById('gameDialogTitle');
        const gameDialogText = document.getElementById('gameDialogText');
        const gameDialogInput = document.getElementById('gameDialogInput');
        const gameDialogOk = document.getElementById('gameDialogOk');
        const gameDialogCancel = document.getElementById('gameDialogCancel');
        let dialogResolve = null;
        let dialogReject = null;
        let dialogIsPrompt = false;

        // HUD animation helpers
        const hudHP = document.getElementById('hudHP');
        const hudAmmo = document.getElementById('hudAmmo');
        let prevHudHP = null;
        let prevHudAmmo = null;

        function hudPulse(el, type = 'pop') {
            if (!el) return;
            el.classList.remove(type);
            void el.offsetWidth;
            el.classList.add(type);
            setTimeout(() => el.classList.remove(type), 400);
        }

        function showGameAlert(text, title = 'Сообщение') {
            return new Promise((resolve) => {
                dialogIsPrompt = false;
                gameDialogTitle.textContent = title;
                gameDialogText.textContent = text;
                gameDialogInput.style.display = 'none';
                gameDialogCancel.style.display = 'none';
                gameDialog.style.display = 'flex';
                dialogResolve = resolve;
                dialogReject = null;
            });
        }

        function showGamePrompt(text, title = 'Ввод') {
            return new Promise((resolve, reject) => {
                dialogIsPrompt = true;
                gameDialogTitle.textContent = title;
                gameDialogText.textContent = text;
                gameDialogInput.style.display = 'block';
                gameDialogInput.value = '';
                gameDialogCancel.style.display = 'inline-block';
                gameDialog.style.display = 'flex';
                gameDialogInput.focus();
                dialogResolve = resolve;
                dialogReject = reject;
            });
        }

        gameDialogOk.addEventListener('click', () => {
            if (dialogIsPrompt) {
                const value = gameDialogInput.value;
                if (dialogResolve) dialogResolve(value);
            } else {
                if (dialogResolve) dialogResolve();
            }
            gameDialog.style.display = 'none';
        });

        gameDialogCancel.addEventListener('click', () => {
            if (dialogIsPrompt) {
                if (dialogReject) dialogReject(null);
            }
            gameDialog.style.display = 'none';
        });

        gameDialogInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                gameDialogOk.click();
            }
        });

        /* =======================
           Neon Miami 2D menu background
        ======================= */
        const menuBg = document.getElementById('menuBg');
        const mctx = menuBg.getContext('2d');
        let menuBgT = 0;
        const stars = Array.from({ length: 140 }, () => ({
            x: Math.random(),
            y: Math.random(),
            r: 0.2 + Math.random() * 1.7,
            p: Math.random() * Math.PI * 2,
            s: 0.5 + Math.random() * 1.6
        }));

        function resizeMenuBg() {
            const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
            menuBg.width = Math.floor(window.innerWidth * dpr);
            menuBg.height = Math.floor(window.innerHeight * dpr);
            menuBg.style.width = window.innerWidth + 'px';
            menuBg.style.height = window.innerHeight + 'px';
            mctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        }
        window.addEventListener('resize', resizeMenuBg);
        resizeMenuBg();

        function setMenuBgVisible(visible) {
            menuBg.style.opacity = visible ? '1' : '0';
        }

        function drawMenuBg() {
            menuBgT += 1 / 60;

            const w = window.innerWidth;
            const h = window.innerHeight;

            // Only animate while in menus; keep it lightweight otherwise
            const menuVisible = (gameState === 'menu');
            setMenuBgVisible(menuVisible);
            if (!menuVisible) {
                requestAnimationFrame(drawMenuBg);
                return;
            }

            // Background gradient
            const g = mctx.createLinearGradient(0, 0, 0, h);
            g.addColorStop(0, '#04040c');
            g.addColorStop(0.55, '#090928');
            g.addColorStop(1, '#020208');
            mctx.fillStyle = g;
            mctx.fillRect(0, 0, w, h);

            // Subtle haze
            const haze = mctx.createRadialGradient(w * 0.5, h * 0.35, 0, w * 0.5, h * 0.35, Math.max(w, h) * 0.8);
            haze.addColorStop(0, 'rgba(255, 0, 255, 0.06)');
            haze.addColorStop(0.55, 'rgba(0, 255, 255, 0.05)');
            haze.addColorStop(1, 'rgba(0, 0, 0, 0)');
            mctx.fillStyle = haze;
            mctx.fillRect(0, 0, w, h);

            // Stars
            for (const s of stars) {
                const tw = 0.55 + 0.45 * Math.sin(menuBgT * s.s * 1.25 + s.p);
                mctx.globalAlpha = tw;
                mctx.fillStyle = 'rgba(255,255,255,0.95)';
                const x = s.x * w;
                const y = s.y * h * 0.7;
                mctx.beginPath();
                mctx.arc(x, y, s.r, 0, Math.PI * 2);
                mctx.fill();
            }
            mctx.globalAlpha = 1;

            // Neon sun
            const sunX = w * 0.72;
            const sunY = h * 0.28;
            const sunR = Math.min(w, h) * 0.16;
            const sunGrad = mctx.createRadialGradient(sunX, sunY, 0, sunX, sunY, sunR);
            sunGrad.addColorStop(0, 'rgba(255, 230, 140, 0.95)');
            sunGrad.addColorStop(0.35, 'rgba(255, 80, 200, 0.85)');
            sunGrad.addColorStop(1, 'rgba(255, 0, 255, 0.0)');
            mctx.fillStyle = sunGrad;
            mctx.beginPath();
            mctx.arc(sunX, sunY, sunR, 0, Math.PI * 2);
            mctx.fill();

            // Sun scanlines
            mctx.save();
            mctx.beginPath();
            mctx.arc(sunX, sunY, sunR * 0.75, 0, Math.PI * 2);
            mctx.clip();
            mctx.globalAlpha = 0.25;
            for (let y = -sunR; y < sunR; y += 6) {
                const yy = sunY + y;
                mctx.fillStyle = y % 12 === 0 ? 'rgba(0,255,255,0.16)' : 'rgba(0,0,0,0.12)';
                mctx.fillRect(sunX - sunR, yy, sunR * 2, 2);
            }
            mctx.restore();
            mctx.globalAlpha = 1;

            // Horizon & grid
            const horizonY = h * 0.62;
            const vanishX = w * 0.5;

            // Horizon glow
            const hz = mctx.createLinearGradient(0, horizonY - 80, 0, horizonY + 120);
            hz.addColorStop(0, 'rgba(255,0,255,0)');
            hz.addColorStop(0.45, 'rgba(255,0,255,0.16)');
            hz.addColorStop(0.6, 'rgba(0,255,255,0.14)');
            hz.addColorStop(1, 'rgba(0,0,0,0)');
            mctx.fillStyle = hz;
            mctx.fillRect(0, horizonY - 80, w, 220);

            // Grid lines (2D perspective illusion)
            mctx.lineWidth = 1;
            mctx.globalAlpha = 0.75;

            // Vertical rays
            const rays = 22;
            for (let i = -rays; i <= rays; i++) {
                const x = vanishX + i * (w / (rays * 2)) * 1.2;
                mctx.strokeStyle = i % 2 === 0 ? 'rgba(0, 255, 255, 0.35)' : 'rgba(255, 0, 255, 0.22)';
                mctx.beginPath();
                mctx.moveTo(vanishX, horizonY);
                mctx.lineTo(x, h);
                mctx.stroke();
            }

            // Horizontal lines moving
            const speed = 0.6;
            const lines = 30;
            for (let i = 0; i < lines; i++) {
                const p = (i / lines);
                const ease = p * p;
                const y = horizonY + ease * (h - horizonY);
                // Make them move: shift index by time
                const phase = (menuBgT * speed) % 1;
                const yy = horizonY + ((ease + phase) % 1) * (h - horizonY);

                const widthAtY = (yy - horizonY) / (h - horizonY);
                const half = (w * 0.9) * widthAtY;

                mctx.strokeStyle = i % 2 === 0 ? 'rgba(255, 0, 255, 0.22)' : 'rgba(0, 255, 255, 0.18)';
                mctx.beginPath();
                mctx.moveTo(vanishX - half, yy);
                mctx.lineTo(vanishX + half, yy);
                mctx.stroke();
            }
            mctx.globalAlpha = 1;

            // Subtle vignette
            const vig = mctx.createRadialGradient(w * 0.5, h * 0.5, Math.min(w, h) * 0.1, w * 0.5, h * 0.5, Math.max(w, h) * 0.75);
            vig.addColorStop(0, 'rgba(0,0,0,0)');
            vig.addColorStop(1, 'rgba(0,0,0,0.55)');
            mctx.fillStyle = vig;
            mctx.fillRect(0, 0, w, h);

            requestAnimationFrame(drawMenuBg);
        }
        requestAnimationFrame(drawMenuBg);

        window.onload = () => {
            drawCharacterIcon('charStandard', '#ff0000', true, false, false);
            drawCharacterIcon('charTank', '#ff8800', false, false, false);
            drawCharacterIcon('charAmmo', '#40E0D0', false, true, false);
            drawCharacterIcon('charMachete', '#9933FF', false, false, true);
            drawCharacterIcon('charPyro', '#ff7a00', false, false, false);

            // Secret character is session-only: hide by default on each reload
            const pyroCard = document.getElementById('charPyroCard');
            if (pyroCard) pyroCard.style.display = 'none';

            try {
                const vol = 1;
                menuMusic.volume = vol;
                level1Music.volume = vol;
                if (level2Music) level2Music.volume = vol;
                if (level3Music) level3Music.volume = vol;
                if (level4Music) level4Music.volume = vol;
                if (bossMusic) bossMusic.volume = vol;
                safePlay(menuMusic);
                menuMusicStarted = true;
            } catch (e) {
                console.warn('Автозапуск музыки меню может быть заблокирован браузером:', e);
            }
        };

        function startLevel1Music() {
            try {
                level1Music.currentTime = 0;
                safePlay(level1Music);
            } catch (e) {
                console.warn('Не удалось запустить музыку уровня 1:', e);
            }
        }

        function stopLevel1Music() {
            try {
                level1Music.pause();
                level1Music.currentTime = 0;
            } catch (e) {}
        }

        // ===== HTML MP3 music for levels (2-4) and boss =====
        let currentHtmlMusic = null;

        function stopAllHtmlMusic(resetTime = true) {
            const all = [level1Music, level2Music, level3Music, level4Music, bossMusic];
            for (const a of all) {
                if (!a) continue;
                try {
                    a.pause();
                    if (resetTime) a.currentTime = 0;
                } catch (e) {}
            }
            currentHtmlMusic = null;
        }

        function startHtmlMusicForLevel(level, restart = true) {
            // stops all other level tracks; leaves menuMusic alone
            stopAllHtmlMusic(restart);
            if (!musicEnabled) return;

            let a = null;
            if (level === 1) a = level1Music;
            else if (level === 2) a = level2Music;
            else if (level === 3) a = level3Music;
            else if (level === 4) a = level4Music;
            else if (level === 5) a = bossMusic;

            if (!a) return;
            try {
                if (restart) a.currentTime = 0;
                safePlay(a);
                currentHtmlMusic = a;
            } catch (e) {
                console.warn('Не удалось запустить HTML-музыку уровня:', e);
                currentHtmlMusic = a;
            }
        }

        function pauseHtmlMusic() {
            if (!currentHtmlMusic) return;
            try { currentHtmlMusic.pause(); } catch (e) {}
        }

        function resumeHtmlMusic() {
            if (!musicEnabled || !currentHtmlMusic) return;
            try { safePlay(currentHtmlMusic); } catch (e) {}
        }

        let settingsOpenedFrom = 'menu';

        function openSettings() {
            settingsOpenedFrom = 'menu';
            document.getElementById('mainMenu').style.display = 'none';
            document.getElementById('settingsMenu').style.display = 'block';
        }

        function openSettingsFromPause() {
            settingsOpenedFrom = 'pause';
            document.getElementById('pauseMenu').style.display = 'none';
            document.getElementById('settingsMenu').style.display = 'block';
        }

        function closeSettings() {
            document.getElementById('settingsMenu').style.display = 'none';
            if (settingsOpenedFrom === 'pause') {
                document.getElementById('pauseMenu').style.display = 'block';
            } else {
                document.getElementById('mainMenu').style.display = 'flex';
            }
        }

        function setLanguage(lang) {
            currentLanguage = lang;
            const texts = {
                ru: {
                    title: 'HOTLINE CIRCLES',
                    start: 'Начать игру',
                    hard: '💀 HARD-MODE 💀',
                    settings: '⚙️ Настройки',
                    settingsTitle: 'НАСТРОЙКИ',
                    languageLabel: 'Язык / Language',
                    resolutionLabel: 'Размер окна',
                    volumeLabel: 'Громкость',
                    settingsBack: 'Назад',

                    levelSelectTitle: 'Выбор уровня',
                    characterSelectTitle: 'Выберите персонажа',
                    back: 'Назад',

                    pauseTitle: 'ПАУЗА',
                    pauseResume: 'Продолжить',
                    pauseRestart: 'Перезапустить уровень',
                    pauseSettings: 'Настройки',
                    pauseExit: 'Выйти в главное меню',

                    deathTitle: '💀 ВЫ ПОГИБЛИ! 💀',
                    deathStats: 'Убито врагов:',
                    deathRestart: '🔄 Перезапустить',
                    deathExit: '🚪 В меню'
                },
                en: {
                    title: 'HOTLINE CIRCLES',
                    start: 'Start Game',
                    hard: '💀 HARD-MODE 💀',
                    settings: '⚙️ Settings',
                    settingsTitle: 'SETTINGS',
                    languageLabel: 'Language',
                    resolutionLabel: 'Window size',
                    volumeLabel: 'Volume',
                    settingsBack: 'Back',

                    levelSelectTitle: 'Level Select',
                    characterSelectTitle: 'Choose character',
                    back: 'Back',

                    pauseTitle: 'PAUSED',
                    pauseResume: 'Resume',
                    pauseRestart: 'Restart level',
                    pauseSettings: 'Settings',
                    pauseExit: 'Exit to main menu',

                    deathTitle: '💀 YOU DIED! 💀',
                    deathStats: 'Enemies killed:',
                    deathRestart: '🔄 Restart',
                    deathExit: '🚪 Main menu'
                }
            }[lang];

            document.getElementById('titleText').textContent = texts.title;
            document.getElementById('startButton').textContent = texts.start;
            document.getElementById('hardModeButton').textContent = texts.hard;
            document.getElementById('settingsButton').textContent = texts.settings;
            document.getElementById('settingsTitle').textContent = texts.settingsTitle;
            document.getElementById('languageLabel').textContent = texts.languageLabel;
            document.getElementById('resolutionLabel').textContent = texts.resolutionLabel;
            document.getElementById('volumeLabel').textContent = texts.volumeLabel;
            document.getElementById('settingsBackButton').textContent = texts.settingsBack;

            const lvlTitle = document.getElementById('levelSelectTitle');
            if (lvlTitle) lvlTitle.textContent = texts.levelSelectTitle;

            const charTitle = document.getElementById('characterSelectTitle');
            if (charTitle) charTitle.textContent = texts.characterSelectTitle;

            const lvlBackBtn = document.querySelector('#levelSelect .menu-footer .menu-button');
            if (lvlBackBtn) lvlBackBtn.textContent = texts.back;
            const charBackBtn = document.querySelector('#characterSelect .menu-footer .menu-button');
            if (charBackBtn) charBackBtn.textContent = texts.back;

            // Pause / death UI
            const pauseTitleEl = document.getElementById('pauseTitle');
            if (pauseTitleEl) pauseTitleEl.textContent = texts.pauseTitle;
            const pauseResumeEl = document.getElementById('pauseResumeBtn');
            if (pauseResumeEl) pauseResumeEl.textContent = texts.pauseResume;
            const pauseRestartEl = document.getElementById('pauseRestartBtn');
            if (pauseRestartEl) pauseRestartEl.textContent = texts.pauseRestart;
            const pauseSettingsEl = document.getElementById('pauseSettingsBtn');
            if (pauseSettingsEl) pauseSettingsEl.textContent = texts.pauseSettings;
            const pauseExitEl = document.getElementById('pauseMenuExitBtn');
            if (pauseExitEl) pauseExitEl.textContent = texts.pauseExit;

            const deathTitleEl = document.getElementById('deathTitle');
            if (deathTitleEl) deathTitleEl.textContent = texts.deathTitle;
            const deathStatsEl = document.getElementById('deathStats');
            if (deathStatsEl) {
                // keep counts spans
                deathStatsEl.innerHTML = `${texts.deathStats} <span id="deathKills">0</span>/<span id="deathTotal">0</span>`;
            }
            const deathRestartEl = document.getElementById('deathRestartBtn');
            if (deathRestartEl) deathRestartEl.textContent = texts.deathRestart;
            const deathExitEl = document.getElementById('deathMenuBtn');
            if (deathExitEl) deathExitEl.textContent = texts.deathExit;

            // Перевод кнопок уровней (только Глава 1)
            const levelButtons = document.querySelectorAll('#levelGrid .level-button');
            if (lang === 'ru') {
                const ruTexts = [
                    '🎓 Уровень 0 - ОБУЧЕНИЕ',
                    '📍 Уровень 1 - СКЛАД',
                    '🏢 Уровень 2 - ОФИС',
                    '🏭 Уровень 3 - ЗАВОД',
                    '📡 Уровень 4 - ШТАБ',
                    '💀 Уровень 5 - БОСС'
                ];
                levelButtons.forEach((btn, i) => { if (ruTexts[i]) btn.textContent = ruTexts[i]; });
            } else {
                const enTexts = [
                    '🎓 Level 0 - TUTORIAL',
                    '📍 Level 1 - WAREHOUSE',
                    '🏢 Level 2 - OFFICE',
                    '🏭 Level 3 - FACTORY',
                    '📡 Level 4 - HQ',
                    '💀 Level 5 - BOSS'
                ];
                levelButtons.forEach((btn, i) => { if (enTexts[i]) btn.textContent = enTexts[i]; });
            }

            // Перевод карточек персонажей
            const charNames = document.querySelectorAll('#characterSelect .character-name');
            const charDescs = document.querySelectorAll('#characterSelect .character-desc');
            if (lang === 'ru') {
                const names = ['Стандарт', 'Танк', 'Стрелок', 'Рубака'];
                const descs = [
                    'Ускоренная стрельба (ПКМ)\n<b>100 HP</b>',
                    'Щит от урона (ПКМ)\n<b>200 HP</b>',
                    'Аптечка +50 HP (ПКМ)\n    x2 боезапас | <b>100 HP</b>',
                    'Буйство (ПКМ)\nМачете 40 урона | <b>125 HP</b>'
                ];
                charNames.forEach((el, i) => { if (names[i]) el.textContent = names[i]; });
                charDescs.forEach((el, i) => { if (descs[i]) el.innerHTML = descs[i]; });
            } else {
                const names = ['Standard', 'Tank', 'Shooter', 'Butcher'];
                const descs = [
                    'Rapid fire (RMB)\n<b>100 HP</b>',
                    'Damage shield (RMB)\n<b>200 HP</b>',
                    'Medkit +50 HP (RMB)\n    x2 ammo | <b>100 HP</b>',
                    'Rage (RMB)\nMachete 40 dmg | <b>125 HP</b>'
                ];
                charNames.forEach((el, i) => { if (names[i]) el.textContent = names[i]; });
                charDescs.forEach((el, i) => { if (descs[i]) el.innerHTML = descs[i]; });
            }

            // Перевод названия уровня в HUD, если игра уже запущена
            const levelNamesRu = ['ОБУЧЕНИЕ', 'СКЛАД', 'ОФИС', 'ЗАВОД', 'ШТАБ', 'БОСС'];
            const levelNamesEn = ['TUTORIAL', 'WAREHOUSE', 'OFFICE', 'FACTORY', 'HQ', 'BOSS'];
            if (typeof currentLevel !== 'undefined') {
                const index = currentLevel;
                if (levelNamesRu[index] && levelNamesEn[index]) {
                    const title = lang === 'ru'
                        ? `УРОВЕНЬ ${index} - ${levelNamesRu[index]}`
                        : `LEVEL ${index} - ${levelNamesEn[index]}`;
                    const levelNameEl = document.getElementById('levelName');
                    if (levelNameEl) levelNameEl.textContent = title;
                }
            }
        }

        function fitGameViewport() {
            const container = document.getElementById('gameContainer');
            const scale = Math.min(1, window.innerWidth / canvas.width, window.innerHeight / canvas.height);
            container.style.width = canvas.width + 'px'; container.style.height = canvas.height + 'px';
            container.style.transform = `translate(-50%, -50%) scale(${scale})`;
        }
        window.addEventListener('resize', fitGameViewport);
        fitGameViewport();

        function changeResolution(value) {
            const [w, h] = value.split('x').map(Number);
            canvas.width = w;
            canvas.height = h;
            fitGameViewport();
        }

        function changeVolume(value) {
            const vol = parseFloat(value);
            menuMusic.volume = vol;
            level1Music.volume = vol;
            if (level2Music) level2Music.volume = vol;
            if (level3Music) level3Music.volume = vol;
            if (level4Music) level4Music.volume = vol;
            if (bossMusic) bossMusic.volume = vol;
            if (masterGain) masterGain.gain.value = vol;
        }

        function drawCharacterIcon(id, color, hasLine, hasBelt, hasSkull = false) {
            const c = document.getElementById(id);
            if (!c) return;
            const ct = c.getContext('2d'), r = id === 'charTank' ? 45 : 30, cx = 50, cy = 50;
            ct.clearRect(0, 0, c.width, c.height);

            // Pyro special icon: must match in-game look (orange circle + 2 red tanks behind)
            if (id === 'charPyro') {
                const aim = 0; // facing right, so tanks are behind (left)
                const back = aim + Math.PI;

                // Base body
                ct.fillStyle = '#ff7a00';
                ct.beginPath();
                ct.arc(cx, cy, r, 0, Math.PI * 2);
                ct.fill();

                // Body glow/gradient (same vibe as in-game)
                const grad = ct.createRadialGradient(cx, cy - 4, 2, cx, cy, r + 12);
                grad.addColorStop(0, 'rgba(255, 240, 170, 0.35)');
                grad.addColorStop(0.25, 'rgba(255, 140, 0, 0.55)');
                grad.addColorStop(1, 'rgba(170, 10, 0, 0.25)');
                ct.save();
                ct.globalCompositeOperation = 'lighter';
                ct.fillStyle = grad;
                ct.beginPath();
                ct.arc(cx, cy, r + 2, 0, Math.PI * 2);
                ct.fill();
                ct.restore();

                // Two tanks behind (same geometry as in-game player)
                const tankOffset = 10;
                const tankDist = r + 10;
                const bx = Math.cos(back) * tankDist;
                const by = Math.sin(back) * tankDist;

                for (const s of [-1, 1]) {
                    const ox = bx + Math.cos(back + Math.PI / 2) * (tankOffset * s);
                    const oy = by + Math.sin(back + Math.PI / 2) * (tankOffset * s);

                    ct.save();
                    ct.translate(cx + ox, cy + oy);
                    ct.rotate(aim);

                    ct.fillStyle = '#b10000';
                    ct.strokeStyle = '#4a0000';
                    ct.lineWidth = 2;
                    ct.beginPath();
                    ct.roundRect(-6, -14, 12, 28, 6);
                    ct.fill();
                    ct.stroke();

                    // highlight
                    ct.globalAlpha = 0.25;
                    ct.fillStyle = '#ff4040';
                    ct.fillRect(-4, -12, 2, 24);
                    ct.globalAlpha = 1;

                    // valve cap
                    ct.fillStyle = '#222';
                    ct.beginPath();
                    ct.arc(0, -16, 4, 0, Math.PI * 2);
                    ct.fill();

                    ct.restore();
                }

                // Outline
                ct.strokeStyle = '#fff';
                ct.lineWidth = 3;
                ct.beginPath();
                ct.arc(cx, cy, r, 0, Math.PI * 2);
                ct.stroke();
                return;
            }

            ct.fillStyle = color;
            ct.beginPath();
            ct.arc(cx, cy, r, 0, Math.PI * 2);
            ct.fill();

            if (hasLine) {
                ct.strokeStyle = '#fff';
                ct.lineWidth = 4;
                ct.beginPath();
                ct.moveTo(cx - r + 5, cy - r + 8);
                ct.lineTo(cx + r - 5, cy - r + 8);
                ct.stroke();
            }

            if (hasBelt) {
                ct.save();
                ct.translate(cx, cy);
                ct.rotate(-Math.PI / 4);
                ct.fillStyle = '#8B4513';
                ct.fillRect(-r - 10, -5, r * 2 + 20, 10);
                for (let i = -r; i <= r; i += 15) {
                    ct.fillStyle = '#FFD700';
                    ct.fillRect(i, -8, 6, 8);
                    ct.fillStyle = '#ff0000';
                    ct.beginPath();
                    ct.moveTo(i + 3, -13);
                    ct.lineTo(i, -8);
                    ct.lineTo(i + 6, -8);
                    ct.closePath();
                    ct.fill();
                    ct.fillStyle = '#ffcccc';
                    ct.beginPath();
                    ct.moveTo(i + 3, -13);
                    ct.lineTo(i + 1, -11);
                    ct.lineTo(i + 3, -8);
                    ct.closePath();
                    ct.fill();
                }
                ct.restore();
            }

            if (hasSkull) {
                ct.fillStyle = '#fff';
                ct.beginPath();
                ct.arc(cx, cy - 8, 15, 0, Math.PI * 2);
                ct.fill();
                ct.fillStyle = '#000';
                ct.beginPath();
                ct.arc(cx - 6, cy - 11, 3, 0, Math.PI * 2);
                ct.arc(cx + 6, cy - 11, 3, 0, Math.PI * 2);
                ct.fill();
                ct.beginPath();
                ct.moveTo(cx, cy - 5);
                ct.lineTo(cx - 2, cy - 1);
                ct.lineTo(cx + 2, cy - 1);
                ct.closePath();
                ct.fill();
                ct.beginPath();
                ct.moveTo(cx - 10, cy + 4);
                ct.lineTo(cx + 10, cy + 4);
                ct.arc(cx, cy + 4, 10, 0, Math.PI, true);
                ct.closePath();
                ct.fill();
            }

            if (color === '#ff8800') {
                ct.strokeStyle = '#000';
                ct.lineWidth = 5;
                ct.beginPath();
                ct.arc(cx, cy, r, 0, Math.PI * 2);
                ct.stroke();
            }
        }

        function showLevelSelect() {
            hardMode = false;
            document.getElementById('mainMenu').style.display = 'none';
            document.getElementById('levelSelect').style.display = 'block';

        }

        function selectLevelForCharacterChoice(level) { selectedLevel = level; document.getElementById('levelSelect').style.display = 'none'; document.getElementById('characterSelect').style.display = 'block'; }
        function backToLevelSelect() { hardMode = false; document.getElementById('characterSelect').style.display = 'none'; document.getElementById('levelSelect').style.display = 'block'; }
        function selectCharacter(character, el) {
            selectedCharacter = character;
            document.querySelectorAll('.character-card').forEach(card => card.classList.remove('selected'));
            if (el) el.classList.add('selected');
            startGame(selectedLevel);
        }
        function backToMainMenu() {
            document.getElementById('levelSelect').style.display = 'none';
            document.getElementById('mainMenu').style.display = 'flex';

        }

        function startHardMode() {
            hardMode = true;
            hardModeProgress = 1;
            medkitUsed = false;
            selectedLevel = 1;
            document.getElementById('mainMenu').style.display = 'none';
            document.getElementById('characterSelect').style.display = 'block';
        }

        function checkSecretCode() {
            showGamePrompt('Введите код:', 'Секретный код').then(code => {
                if (code === '8267') {
                    const card = document.getElementById('charPyroCard');
                    if (card) card.style.display = 'block';
                    showGameAlert('Все верно! Персонаж «Поджигатель» открыт.', 'Секретный код');
                    console.log('Секретный код принят! Поджигатель открыт');
                } else if (code !== null && code !== undefined) {
                    showGameAlert('Подумай ещё...', 'Секретный код');
                }
            }).catch(() => {});
        }

        document.addEventListener('keydown', (e) => {
            keys[e.key.toLowerCase()] = true;
            if (e.key === 'ц' || e.key === 'Ц') keys['w'] = true;
            if (e.key === 'ф' || e.key === 'Ф') keys['a'] = true;
            if (e.key === 'ы' || e.key === 'Ы') keys['s'] = true;
            if (e.key === 'в' || e.key === 'В') keys['d'] = true;

            if (e.key === 'Escape' && gameState === 'playing') pauseGame();
            else if (e.key === 'Escape' && gameState === 'paused') resumeGame();

            if (gameState === 'playing' && (e.key.toLowerCase() === 'e' || e.key === 'у' || e.key === 'У')) pickupWeapon();
            if (e.key === ' ' && gameState === 'playing') { e.preventDefault(); switchToPistol(); }
        });
        document.addEventListener('keyup', (e) => {
            keys[e.key.toLowerCase()] = false;
            if (e.key === 'ц' || e.key === 'Ц') keys['w'] = false;
            if (e.key === 'ф' || e.key === 'Ф') keys['a'] = false;
            if (e.key === 'ы' || e.key === 'Ы') keys['s'] = false;
            if (e.key === 'в' || e.key === 'В') keys['d'] = false;
        });
        canvas.addEventListener('mousemove', (e) => {
            const rect = canvas.getBoundingClientRect();
            mouse.x = (e.clientX - rect.left) * canvas.width / rect.width; mouse.y = (e.clientY - rect.top) * canvas.height / rect.height;
            mouse.worldX = mouse.x + camera.x; mouse.worldY = mouse.y + camera.y;
        });
        canvas.addEventListener('mousedown', e => { if (e.button === 0 && gameState === 'playing') mouse.clicked = true; });
        window.addEventListener('mouseup', e => { if (e.button === 0) mouse.clicked = false; });
        function resetInput() { for (const key in keys) keys[key] = false; mouse.clicked = false; }
        window.addEventListener('blur', () => { resetInput(); if (gameState === 'playing') pauseGame(); });
        document.addEventListener('visibilitychange', () => { if (document.hidden) { resetInput(); if (gameState === 'playing') pauseGame(); } });
        canvas.addEventListener('contextmenu', (e) => { e.preventDefault(); useAbility(); });

        function useAbility() {
            if (!abilityAvailable || gameState !== 'playing') return;

            if (selectedCharacter === 'standard') {
                if (player.weapon === player.startingWeapon) return;
                abilityAvailable = false; abilityActive = true; abilityTimer = 180;
                originalFireRate = weapons[player.weapon].fireRate;
                currentWeapon.fireRate = Math.floor(originalFireRate / 3);
                document.getElementById('abilityStatus').style.display = 'block';
                document.getElementById('abilityText').textContent = 'Активна!';
                document.getElementById('abilityText').style.color = '#00ff00';
            } else if (selectedCharacter === 'tank') {
                abilityAvailable = false; abilityActive = true; abilityTimer = 180;
                document.getElementById('abilityStatus').style.display = 'block';
                document.getElementById('abilityText').textContent = 'Щит активен!';
                document.getElementById('abilityText').style.color = '#00ffff';
            } else if (selectedCharacter === 'ammo') {
                if (medkitUsed || player.hp >= player.maxHP) return;
                medkitUsed = true;
                abilityAvailable = false;
                player.hp = Math.min(player.maxHP, player.hp + 50);
                updateHUD();
                document.getElementById('abilityStatus').style.display = 'block';
                document.getElementById('abilityText').textContent = 'Использована!';
                document.getElementById('abilityText').style.color = '#ff0000';
            } else if (selectedCharacter === 'machete_char') {
                abilityAvailable = false; abilityActive = true; abilityTimer = 600;
                weapons.machete.range = 150;
                currentWeapon.range = 150;
                document.getElementById('abilityStatus').style.display = 'block';
                document.getElementById('abilityText').textContent = 'БУЙСТВО!';
                document.getElementById('abilityText').style.color = '#ff0000';
            } else if (selectedCharacter === 'pyro') {
                // Fire aura: damages enemies in a circle and regenerates flamethrower fuel while active
                abilityAvailable = false; abilityActive = true; abilityTimer = 600; // 10 seconds
                pyroAura.active = true;
                pyroAura.t = 0;
                pyroAura.tickAcc = 0;

                document.getElementById('abilityStatus').style.display = 'block';
                document.getElementById('abilityText').textContent = 'Огненный круг!';
                document.getElementById('abilityText').style.color = '#ff7a00';
            }
        }

        function updateAbility() {
            if (abilityActive) {
                abilityTimer--;
                if (abilityTimer <= 0) {
                    abilityActive = false;
                    if (selectedCharacter === 'standard') currentWeapon.fireRate = weapons[player.weapon].fireRate;
                    else if (selectedCharacter === 'machete_char') { weapons.machete.range = originalMacheteRange; currentWeapon.range = originalMacheteRange; }
                    else if (selectedCharacter === 'pyro') { pyroAura.active = false; }
                    document.getElementById('abilityText').textContent = 'Использована';
                    document.getElementById('abilityText').style.color = '#ff0000';
                }
            }
        }

        function initAudio() {
            if (!audioContext) {
                audioContext = new (window.AudioContext || window.webkitAudioContext)();
                masterGain = audioContext.createGain();
                masterGain.gain.value = parseFloat(document.getElementById('volumeSlider').value || '1');
                masterGain.connect(audioContext.destination);
            }
        }

        function playLevelMusic(level) {
            if (!musicEnabled || !audioContext) return;
            stopMusic();
            if (level === 1) { return; }
            if (level === 5) { playBossMusic(); return; }
            const configs = [
                { bpm: 90, pattern: (b) => { if (b % 2 === 0) playKick(); if (b % 8 === 4) playSnare(); playHihat(); playBass(100); if (b % 4 === 0) playSynth([220, 262, 330, 262][b/4 % 4], 0.4, 'sine'); } },
                { bpm: 100, pattern: (b) => { const s = b % 16; if (s % 4 === 0) playKick(); if (s === 4 || s === 12) playSnare(); if (s % 2 === 0) { playHihat(); playBass(110); } if (s % 4 === 0) playSynth([440, 494, 523, 494, 440, 392, 349, 392][s / 4 % 8], 0.3, 'square'); } },
                { bpm: 128, pattern: (b) => { const s = b % 32, sec = Math.floor(b / 32) % 2; if (s % 2 === 0) playKick(); if (s === 4 || s === 12 || s === 20 || s === 28) playSnare(); playHihat(); if (s % 2 === 0) { playBass([[98, 98, 110, 98, 110, 123, 110, 98], [82, 82, 98, 82, 110, 98, 82, 73]][sec][Math.floor(s / 2) % 8]); playSynth([[392, 440, 494, 523, 494, 440, 392, 349], [523, 587, 659, 698, 659, 587, 523, 494]][sec][Math.floor(s / 2) % 8], 0.15, 'sawtooth'); } } },
                { bpm: 145, pattern: (b) => { const s = b % 64; playKick(); if (s % 8 === 4) playSnare(); playHihat(); playBass([65, 69, 73, 69, 65, 58, 55, 58][s % 8]); playSynth([330, 349, 392, 440, 392, 349, 330, 294][s % 8], 0.12, 'triangle'); if (s % 16 === 0) playDistortedHit(); } },
                { bpm: 165, pattern: (b) => { const s = b % 64; playKick(); if (s % 4 === 2) playSnare(); playHihat(); playBass([55, 58, 62, 65, 69, 73, 77, 82][s % 8]); playSynth([523, 587, 659, 740, 784, 880, 988, 1047][s % 8], 0.18, 'sawtooth'); if (s % 8 === 0) playDistortedHit(); } }
            ];
            if (configs[level]) {
                let beat = 0;
                const interval = setInterval(() => { configs[level].pattern(beat); beat++; }, (60 / configs[level].bpm) * 250);
                musicIntervals.push(interval);
            }
        }

        function playKick() { const o = audioContext.createOscillator(), g = audioContext.createGain(); o.frequency.setValueAtTime(150, audioContext.currentTime); o.frequency.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.5); g.gain.setValueAtTime(1, audioContext.currentTime); g.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.5); o.connect(g); g.connect(masterGain); o.start(audioContext.currentTime); o.stop(audioContext.currentTime + 0.5); }
        function playBass(note) { const o = audioContext.createOscillator(), g = audioContext.createGain(); o.type = 'sawtooth'; o.frequency.setValueAtTime(note, audioContext.currentTime); g.gain.setValueAtTime(0.3, audioContext.currentTime); g.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.3); o.connect(g); g.connect(masterGain); o.start(audioContext.currentTime); o.stop(audioContext.currentTime + 0.3); }
        function playHihat() { const bufferSize = audioContext.sampleRate * 0.1, buffer = audioContext.createBuffer(1, bufferSize, audioContext.sampleRate), output = buffer.getChannelData(0); for (let i = 0; i < bufferSize; i++) output[i] = Math.random() * 2 - 1; const noise = audioContext.createBufferSource(); noise.buffer = buffer; const filter = audioContext.createBiquadFilter(); filter.type = 'highpass'; filter.frequency.value = 8000; const gain = audioContext.createGain(); gain.gain.setValueAtTime(0.15, audioContext.currentTime); gain.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.1); noise.connect(filter); filter.connect(gain); gain.connect(masterGain); noise.start(audioContext.currentTime); }
        function playSnare() { const o = audioContext.createOscillator(), noise = audioContext.createBufferSource(), bufferSize = audioContext.sampleRate * 0.2, buffer = audioContext.createBuffer(1, bufferSize, audioContext.sampleRate), output = buffer.getChannelData(0); for (let i = 0; i < bufferSize; i++) output[i] = Math.random() * 2 - 1; noise.buffer = buffer; const oscGain = audioContext.createGain(), noiseGain = audioContext.createGain(); o.frequency.setValueAtTime(200, audioContext.currentTime); oscGain.gain.setValueAtTime(0.5, audioContext.currentTime); oscGain.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.2); noiseGain.gain.setValueAtTime(0.5, audioContext.currentTime); noiseGain.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.2); o.connect(oscGain); noise.connect(noiseGain); oscGain.connect(masterGain); noiseGain.connect(masterGain); o.start(audioContext.currentTime); noise.start(audioContext.currentTime); o.stop(audioContext.currentTime + 0.2); }
        function playSynth(freq, duration = 0.2, type = 'sine') { const o = audioContext.createOscillator(), g = audioContext.createGain(); o.type = type; o.frequency.setValueAtTime(freq, audioContext.currentTime); g.gain.setValueAtTime(0.1, audioContext.currentTime); g.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + duration); o.connect(g); g.connect(masterGain); o.start(audioContext.currentTime); o.stop(audioContext.currentTime + duration); }
        function playDistortedHit() { const o = audioContext.createOscillator(), g = audioContext.createGain(), d = audioContext.createWaveShaper(), curve = new Float32Array(256); for (let i = 0; i < 256; i++) { const x = (i * 2) / 256 - 1; curve[i] = Math.tanh(3 * x); } d.curve = curve; o.frequency.setValueAtTime(100, audioContext.currentTime); g.gain.setValueAtTime(0.3, audioContext.currentTime); g.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.1); o.connect(d); d.connect(g); g.connect(masterGain); o.start(audioContext.currentTime); o.stop(audioContext.currentTime + 0.1); }

        function playBossMusic() {
            let beat = 0;
            const interval = setInterval(() => {
                const s = beat % 16;
                if (s % 2 === 0) playHeavyKick();
                if (s % 1 === 0) playAggressiveBass();
                if (s % 2 === 0) playChaoticLead();
                if (s % 3 === 0) playHeavyNoise();
                beat++;
            }, (60 / 180) * 250);
            musicIntervals.push(interval);
        }

        function playHeavyKick() { const o = audioContext.createOscillator(), g = audioContext.createGain(); o.frequency.setValueAtTime(60, audioContext.currentTime); o.frequency.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.3); g.gain.setValueAtTime(1.5, audioContext.currentTime); g.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.3); o.connect(g); g.connect(masterGain); o.start(audioContext.currentTime); o.stop(audioContext.currentTime + 0.3); }
        function playAggressiveBass() { const o = audioContext.createOscillator(), g = audioContext.createGain(); o.type = 'sawtooth'; o.frequency.setValueAtTime([55, 58, 62, 65][Math.floor(Math.random() * 4)], audioContext.currentTime); g.gain.setValueAtTime(0.4, audioContext.currentTime); g.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.2); o.connect(g); g.connect(masterGain); o.start(audioContext.currentTime); o.stop(audioContext.currentTime + 0.2); }
        function playChaoticLead() { const o = audioContext.createOscillator(), g = audioContext.createGain(); o.type = 'square'; o.frequency.setValueAtTime([220, 233, 247, 262][Math.floor(Math.random() * 4)], audioContext.currentTime); g.gain.setValueAtTime(0.15, audioContext.currentTime); g.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.15); o.connect(g); g.connect(masterGain); o.start(audioContext.currentTime); o.stop(audioContext.currentTime + 0.15); }
        function playHeavyNoise() { const bufferSize = audioContext.sampleRate * 0.05, buffer = audioContext.createBuffer(1, bufferSize, audioContext.sampleRate), output = buffer.getChannelData(0); for (let i = 0; i < bufferSize; i++) output[i] = (Math.random() - 0.5) * 2; const noise = audioContext.createBufferSource(); noise.buffer = buffer; const g = audioContext.createGain(); g.gain.setValueAtTime(0.2, audioContext.currentTime); g.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.05); noise.connect(g); g.connect(masterGain); noise.start(audioContext.currentTime); }

        function playCowboyMusic() {
            let beat = 0;
            const interval = setInterval(() => {
                const s = beat % 32;
                if (s % 2 === 0) playKick(); if (s % 4 === 2) playSnare(); playHihat();
                if (s % 4 === 0) playBass([82, 87, 98, 110][s / 4 % 4]);
                if (s % 1 === 0) playSynth([330, 349, 392, 440, 494, 523, 587, 659][s % 8], 0.1, 'square');
                if (s % 2 === 0) playSynth([330, 349, 392, 440, 494, 523, 587, 659][(s + 4) % 8] * 1.5, 0.15, 'sawtooth');
                if (s % 8 === 0) playDistortedHit(); if (s % 3 === 0) playHeavyNoise();
                beat++;
            }, (60 / 200) * 250);
            musicIntervals.push(interval);
        }

        function stopMusic() { musicIntervals.forEach(interval => clearInterval(interval)); musicIntervals = []; }
        function toggleMusic() {
            musicEnabled = !musicEnabled;

            if (!musicEnabled) {
                // Stop synth music (legacy) + pause current HTML track
                stopMusic();
                try { menuMusic.pause(); } catch (e) {}
                pauseHtmlMusic();
                return;
            }

            // Enable
            if (gameState === 'menu') {
                try { safePlay(menuMusic); } catch (e) {}
                return;
            }

            // Don't start music while paused; resume when unpaused
            if (gameState !== 'playing') return;

            // Resume current track if present; otherwise start correct level track
            if (currentHtmlMusic) {
                resumeHtmlMusic();
            } else {
                startHtmlMusicForLevel(currentLevel, false);
            }
        }

        function playSound(type) {
            if (!audioContext) return;

            // Special: continuous-ish flame "whoosh" kept short to avoid audio spam
            if (type === 'flame') {
                const t = audioContext.currentTime;
                const noiseBufferSize = Math.floor(audioContext.sampleRate * 0.08);
                const buffer = audioContext.createBuffer(1, noiseBufferSize, audioContext.sampleRate);
                const data = buffer.getChannelData(0);
                for (let i = 0; i < noiseBufferSize; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / noiseBufferSize);
                const noise = audioContext.createBufferSource();
                noise.buffer = buffer;

                const filter = audioContext.createBiquadFilter();
                filter.type = 'bandpass';
                filter.frequency.setValueAtTime(900, t);
                filter.Q.setValueAtTime(0.7, t);

                const g = audioContext.createGain();
                g.gain.setValueAtTime(0.10, t);
                g.gain.exponentialRampToValueAtTime(0.01, t + 0.08);

                noise.connect(filter);
                filter.connect(g);
                g.connect(masterGain);
                noise.start(t);
                noise.stop(t + 0.08);
                return;
            }

            const o = audioContext.createOscillator(), g = audioContext.createGain();
            o.connect(g); g.connect(masterGain);
            const sounds = { pew: [400, 'square', 0.1], boom: [100, 'sawtooth', 0.15], tak: [800, 'sine', 0.08], brr: [600, 'triangle', 0.06], snipe: [1200, 'sine', 0.2], slice: [600, 'sawtooth', 0.2], hit_target: [2000, 'square', 0.1] };
            if (sounds[type]) { o.frequency.value = sounds[type][0]; o.type = sounds[type][1]; g.gain.value = sounds[type][2]; }
            o.start(); g.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.1); o.stop(audioContext.currentTime + 0.1);
        }

        function restartLevel() {
            document.getElementById('deathMenu').style.display = 'none';
            document.getElementById('pauseMenu').style.display = 'none';
            abilityAvailable = true;
            abilityActive = false;
            abilityTimer = 0;
            pyroAura.active = false;
            pyroAura.t = 0;
            pyroAura.tickAcc = 0;

            stopMusic();
            stopAllHtmlMusic(true);

            if (hardMode) {
                sessionToken++; combatTimers = []; resetInput();
                gameState = 'menu';
                hardModeProgress = 1;
                medkitUsed = false;
                document.getElementById('gameContainer').style.display = 'none';
                document.getElementById('characterSelect').style.display = 'block';
                selectedLevel = 1;
            } else {
                initLevel(currentLevel);
                gameState = 'playing';
                if (musicEnabled) {
                    startHtmlMusicForLevel(currentLevel, true);
                }
            }
        }
        function exitToMenu() { document.getElementById('deathMenu').style.display = 'none'; document.getElementById('pauseMenu').style.display = 'none'; backToMainMenuFromGame(); }
        function pauseGame() {
            resetInput();
            if (gameState === 'playing') {
                gameState = 'paused';
                stopMusic();
                pauseHtmlMusic();
                document.getElementById('pauseMenu').style.display = 'block';
            }
        }
        function resumeGame() {
            if (gameState === 'paused') {
                gameState = 'playing';
                document.getElementById('pauseMenu').style.display = 'none';
                if (musicEnabled) {
                    resumeHtmlMusic();
                }
            }
        }

        function startGame(level) {
            Campaign.get(level); // Reject removed/unknown level IDs before mutating state.
            levelSeed = Math.floor(Math.random() * 0x100000000) >>> 0;
            initAudio();
            if (!menuMusicStarted) {
                try {
                    safePlay(menuMusic);
                    menuMusicStarted = true;
                } catch (e) {}
            }
            menuMusic.pause();
            menuMusic.currentTime = 0;
            stopMusic();
            stopAllHtmlMusic(true);

            // Keep HARD-MODE progress in sync with the level being played
            if (hardMode) {
                hardModeProgress = level;
            }

            currentLevel = level; gameState = 'playing';
            // Safety: ensure pyro aura never carries over into a new game start
            pyroAura.active = false;
            pyroAura.t = 0;
            pyroAura.tickAcc = 0;

            document.getElementById('mainMenu').style.display = 'none';
            document.getElementById('levelSelect').style.display = 'none';
            document.getElementById('characterSelect').style.display = 'none';
            document.getElementById('gameContainer').style.display = 'block';
            document.getElementById('deathMenu').style.display = 'none';
            document.getElementById('pauseMenu').style.display = 'none';
            fitGameViewport();

            {
                const levelNames = ['ОБУЧЕНИЕ', 'СКЛАД', 'ОФИС', 'ЗАВОД', 'ШТАБ', 'БОСС'];
                document.getElementById('levelName').textContent = `УРОВЕНЬ ${level} - ${levelNames[level]}`;
            }

            document.getElementById('bossHealth').style.display = level === 5 ? 'block' : 'none';

            const abilityTexts = {
                standard: 'Готова (ПКМ)',
                tank: 'Готова (ПКМ)',
                ammo: 'Готова (ПКМ)',
                machete_char: 'Готова (ПКМ)',
                pyro: 'Готова (ПКМ)'
            };

            if (abilityTexts[selectedCharacter]) {
                document.getElementById('abilityStatus').style.display = 'block';
                document.getElementById('abilityText').textContent = abilityTexts[selectedCharacter];
                document.getElementById('abilityText').style.color = '#00ff00';
            } else {
                document.getElementById('abilityStatus').style.display = 'none';
            }

            initLevel(level);

            if (musicEnabled) {
                // Use MP3 tracks for levels 1-5: 2.mp3..6.mp3
                if (level <= 5) startHtmlMusicForLevel(level, true);
            }
        }

        function switchToPistol() {
            equipWeapon(player.startingWeapon);
        }

        let ambientParticles = [];

        function initLevel(level) {
            Campaign.get(level);
            sessionToken++; combatTimers = []; simulationTime = 0;
            levelRandom = GameWorld.seeded(levelSeed ^ (level * 7919));
            combatEffects.reset(); muzzleFlashes = [];
            canShoot = true; shootCooldown = 0; resetInput();
            camera.shakeDuration = 0; camera.shakeX = 0; camera.shakeY = 0;
            weapons.machete.range = originalMacheteRange;
            player.x = level === 0 ? WORLD_WIDTH / 2 : 150; player.y = level === 0 ? WORLD_HEIGHT / 2 : 150;
            abilityAvailable = true; abilityActive = false; abilityTimer = 0;
            player.lastHpThreshold = 100;
            medkitUsed = false;
            document.getElementById('miniBossHealth').style.display = 'none';
            for (const type in weapons) if (weapons[type].originalAmmo !== undefined) { weapons[type].ammo = weapons[type].originalAmmo; delete weapons[type].originalAmmo; }

            applyLevelTheme(level);

            const charConfigs = {
                standard: { hp: 100, maxHP: 100, color: '#ff0000', hasTopLine: true, radius: 15, startingWeapon: 'pistol' },
                tank: { hp: 200, maxHP: 200, color: '#ff8800', hasTopLine: false, radius: 22, startingWeapon: 'pistol' },
                ammo: { hp: 100, maxHP: 100, color: '#40E0D0', hasTopLine: false, radius: 15, startingWeapon: 'pistol' },
                machete_char: { hp: 125, maxHP: 125, color: '#9933FF', hasTopLine: false, radius: 15, startingWeapon: 'machete' },
                pyro: { hp: 100, maxHP: 100, color: '#ff7a00', hasTopLine: false, radius: 15, startingWeapon: 'flamethrower' }
            };
            Object.assign(player, charConfigs[selectedCharacter]);
            if (selectedCharacter === 'ammo') for (const type in weapons) if (weapons[type].ammo !== Infinity) { weapons[type].originalAmmo = weapons[type].ammo; weapons[type].ammo *= 2; }

            // Reset per-run weapon state
            // Important: clear current weapon references so we don't carry ammo from previous level
            player.weapon = null;
            currentWeapon = null;
            playerWeaponsState = {};
            // Ensure starting weapon exists in state (with current "weapons" params, incl. ammo x2 for shooter)
            ensureWeaponState(player.startingWeapon);
            equipWeapon(player.startingWeapon);

            enemies = []; bullets = []; enemyBullets = []; weaponPickups = []; walls = []; obstacles = []; boss = null; miniBoss = null; mainEnemiesDefeated = false; kills = 0; weaponSpawnTimer = 0; macheteSlash = null;
            flameParticles = [];
            flameHeat = [];
            flameFuelPickups = [];
            flameFuelSpawnedThisZero = false;

            // Pyro ability must never carry over between levels
            pyroAura.active = false;
            pyroAura.t = 0;
            pyroAura.tickAcc = 0;
            pyroTutorialStartAmmo = null;

            tutorialStage = 0; tutorialTargets = []; tutorialTextElement.style.display = 'none';

            createObstacles(level);
            createGraffitiForLevel(level);
            initAmbient(level);
            if (level === 0) createTutorialLevel();
            else if (level === 5) createBoss();
            else { createEnemies(level); createWeaponPickups(level); }
            camera.x = Math.max(0, Math.min(player.x - canvas.width / 2, WORLD_WIDTH - canvas.width));
            camera.y = Math.max(0, Math.min(player.y - canvas.height / 2, WORLD_HEIGHT - canvas.height));
            updateHUD();
        }

        function initAmbient(level) {
            ambientParticles = [];
            const amb = levelTheme.ambient;
            if (!amb) return;

            // Keep ambient lightweight to avoid FPS drops
            const count = (level === 2) ? 28 : (level === 4 ? 52 : 44);
            for (let i = 0; i < count; i++) {
                ambientParticles.push({
                    x: Math.random() * WORLD_WIDTH,
                    y: Math.random() * WORLD_HEIGHT,
                    r: 0.6 + Math.random() * (level === 4 ? 2.2 : 1.6),
                    a: Math.random() * Math.PI * 2,
                    s: 0.2 + Math.random() * 0.9,
                    t: Math.random() * 1000
                });
            }
        }

        function updateAmbient() {
            const amb = levelTheme.ambient;
            if (!amb || !ambientParticles.length) return;

            for (const p of ambientParticles) {
                p.t += 1;
                if (amb.type === 'dust') {
                    p.x += 0.15 + p.s * 0.25;
                    p.y += Math.sin((p.t + p.a) * 0.02) * 0.2;
                } else if (amb.type === 'steam') {
                    p.y -= 0.25 + p.s * 0.55;
                    p.x += Math.cos((p.t + p.a) * 0.015) * 0.25;
                } else if (amb.type === 'embers') {
                    p.y -= 0.35 + p.s * 0.85;
                    p.x += Math.sin((p.t + p.a) * 0.03) * 0.35;
                } else if (amb.type === 'flicker') {
                    // stationary dots used as light specks (optimized)
                    if ((p.t & 7) === 0) {
                        p.x += (Math.sin(p.a) * 0.10);
                        p.y += (Math.cos(p.a) * 0.10);
                    }
                } else if (amb.type === 'void') {
                    p.x += Math.sin((p.t + p.a) * 0.012) * 0.18;
                    p.y += Math.cos((p.t + p.a) * 0.012) * 0.18;
                }

                if (p.x < 0) p.x += WORLD_WIDTH;
                if (p.x > WORLD_WIDTH) p.x -= WORLD_WIDTH;
                if (p.y < 0) p.y += WORLD_HEIGHT;
                if (p.y > WORLD_HEIGHT) p.y -= WORLD_HEIGHT;
            }
        }

        function drawAmbient() {
            const amb = levelTheme.ambient;
            if (!amb || !ambientParticles.length) return;

            // Lightweight ambient drawing (avoid expensive blend modes)
            ctx.save();
            ctx.globalCompositeOperation = 'source-over';
            for (const p of ambientParticles) {
                // Precomputed-ish flicker using a tiny oscillation; keep it subtle
                const tw = 0.65 + 0.35 * Math.sin((p.t + p.a) * 0.02);
                ctx.globalAlpha = 0.12 * tw;
                ctx.fillStyle = tw > 0.72 ? amb.colorA : amb.colorB;
                ctx.beginPath();
                ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
                ctx.fill();
            }
            ctx.globalAlpha = 1;
            ctx.restore();
        }

        function applyLevelTheme(level) {
            // Visual-only themes (do not affect gameplay). Kept subtle but distinctive.
            const themes = {
                0: { floorA: '#101018', floorB: '#0a0a12', grid: '#26263a', ambient: null },
                1: { floorA: '#171717', floorB: '#121212', grid: '#303030', ambient: { type: 'dust', colorA: 'rgba(255,210,120,0.10)', colorB: 'rgba(255,255,255,0.06)' } }, // WAREHOUSE
                2: { floorA: '#151724', floorB: '#10121c', grid: '#2a2f4a', ambient: { type: 'flicker', colorA: 'rgba(120,255,220,0.10)', colorB: 'rgba(255,255,255,0.05)' } }, // OFFICE
                3: { floorA: '#141a16', floorB: '#0f1411', grid: '#2b3a31', ambient: { type: 'steam', colorA: 'rgba(180,255,200,0.10)', colorB: 'rgba(255,255,255,0.04)' } }, // FACTORY
                4: { floorA: '#0f1412', floorB: '#0b0f0d', grid: '#26352f', ambient: { type: 'dust', colorA: 'rgba(170,255,210,0.07)', colorB: 'rgba(255,255,255,0.03)' } }, // HQ
                5: { floorA: '#0f0f12', floorB: '#0a0a0d', grid: '#2a2a33', ambient: { type: 'void', colorA: 'rgba(255,0,255,0.08)', colorB: 'rgba(0,255,255,0.08)' } },

            };
            levelTheme = themes[level] || themes[1];
        }

        function createGraffitiForLevel(level) {
            graffiti = [];
            if (level < 1 || level > 4) return;

            const digitByLevel = { 1: '8', 2: '2', 3: '6', 4: '7' };
            const digit = digitByLevel[level];
            if (!digit) return;

            // Place on floor at a random free position (subtle, not on walls)
            const pos = getRandomFreePosition();
            if (!pos) return;
            const x = pos.x;
            const y = pos.y;

            // Small, subtle chalk-like digit
            graffiti.push({
                x,
                y,
                digit,
                rotation: 0,
                size: 54 + Math.floor(Math.random() * 16),
                rough: 0.25 + Math.random() * 0.25
            });
        }

        function drawGraffiti() {
            if (!graffiti || !graffiti.length) return;

            for (const g of graffiti) {
                ctx.save();
                ctx.translate(g.x, g.y);
                ctx.rotate(g.rotation);

                // Slightly uneven chalk stroke using multiple draws (no animation)
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.font = `700 ${g.size}px Courier New`;

                // soft shadow to blend with floor
                ctx.globalAlpha = 0.20;
                ctx.fillStyle = 'rgba(0,0,0,0.9)';
                ctx.fillText(g.digit, 2, 3);

                // chalk layers
                ctx.globalAlpha = 0.62;
                ctx.fillStyle = 'rgba(245,245,245,0.95)';
                ctx.fillText(g.digit, 0, 0);

                ctx.globalAlpha = 0.22;
                ctx.fillStyle = 'rgba(255,255,255,0.75)';
                // a couple of jittered passes to simulate hand-drawn chalk
                ctx.fillText(g.digit, -1, 1);
                ctx.fillText(g.digit, 1, -1);

                // subtle scuffs
                ctx.globalAlpha = 0.08;
                ctx.strokeStyle = 'rgba(255,255,255,0.7)';
                ctx.lineWidth = 2;
                ctx.beginPath();
                ctx.moveTo(-g.size * 0.45, g.size * 0.22);
                ctx.lineTo(g.size * 0.48, g.size * 0.18);
                ctx.stroke();

                ctx.restore();
            }
        }

        function createObstacles(level) {
            const layout = Campaign.build(level, levelSeed, GameWorld, WORLD_WIDTH, WORLD_HEIGHT);
            walls = layout.walls; obstacles = layout.obstacles; navigation = layout.nav;
            navigationWallCount = walls.length;
        }

        function createTutorialLevel() {
            player.x = WORLD_WIDTH / 2; player.y = WORLD_HEIGHT / 2;
            const positions = [[700, 300], [1000, 400], [1300, 350], [700, WORLD_HEIGHT - 300], [1000, WORLD_HEIGHT - 400], [1300, WORLD_HEIGHT - 350], [WORLD_WIDTH - 500, WORLD_HEIGHT / 2]];
            positions.forEach(([x, y]) => tutorialTargets.push({ x, y, radius: 25, hp: 100, maxHP: 100, hit: false, color: '#00cc00' }));

            tutorialStage = -1;
            const classInfo = {
                standard: "ВЫ - СТАНДАРТ\n\nСпособность: Ускоренная стрельба (ПКМ)\nНажмите ПКМ с подобранным оружием чтобы стрелять в 3 раза быстрее!\n\nСтиль: Универсальный боец. Подбирайте оружие и используйте способность для максимального урона.\n\nHP: 100\n\n(Нажмите любую клавишу)",
                tank: "ВЫ - ТАНК\n\nСпособность: Щит от урона (ПКМ)\nНажмите ПКМ чтобы активировать щит на 3 секунды - он блокирует весь урон!\n\nСтиль: Агрессивный штурм. Врывайтесь в гущу врагов под защитой щита.\n\nHP: 200 (самый живучий!)\n\n(Нажмите любую клавишу)",
                ammo: "ВЫ - СТРЕЛОК\n\nСпособность: Аптечка (ПКМ)\nНажмите ПКМ чтобы восстановить 50 HP. Работает 1 раз за уровень!\n\nБонус: У вас x2 боезапас для всего оружия.\n\nСтиль: Держите дистанцию, стреляйте точно. Аптечка - на крайний случай.\n\nHP: 100\n\n(Нажмите любую клавишу)",
                machete_char: "ВЫ - РУБАКА\n\nСпособность: Буйство (ПКМ)\nНажмите ПКМ для активации буйства на 10 секунд!\nРадиус удара увеличивается + можете ломать препятствия.\n\nОружие: Мачете (40 урона, ближний бой)\n\nСтиль: Агрессивная резня. Врывайтесь в толпу и рубите всех!\n\nHP: 125\n\n(Нажмите любую клавишу)",
                pyro: "ВЫ - ПОДЖИГАТЕЛЬ\n\nОружие: Огнемет (ЛКМ)\n100 топлива | Средняя дальность\n\nОсобенность: при 0 топлива на карте появится +30 топлива\n\nСпособность: Огненный круг (ПКМ)\n10 секунд: наносит урон врагам в радиусе и\nвосстанавливает топливо +10/сек\n\nHP: 100\n\n(Нажмите любую клавишу)"
            };
            displayTutorialText(classInfo[selectedCharacter]);
        }

        function updateTutorial() {
            const tutorials = {
                standard: () => {
                    switch(tutorialStage) {
                        case -1: if (Object.values(keys).some(k => k)) { displayTutorialText("Добро пожаловать!\nИспользуйте WASD для перемещения."); tutorialStage = 0; } break;
                        case 0: if (keys['w'] || keys['a'] || keys['s'] || keys['d']) { displayTutorialText("Отлично! Стреляйте ЛКМ по мишеням.", 3000); tutorialStage = 1; } break;
                        case 1:
                            let allHit1 = true;
                            tutorialTargets.forEach(t => { if (!t.hit) allHit1 = false; });
                            if (allHit1) { displayTutorialText("Подберите Дробовик (подойдите и нажмите E).", 3000); createWeaponPickup('shotgun', WORLD_WIDTH - 300, WORLD_HEIGHT / 2); tutorialStage = 2; }
                            break;
                        case 2: if (player.weapon === 'shotgun') { displayTutorialText("Теперь используйте СПОСОБНОСТЬ!\nНажмите ПКМ для ускоренной стрельбы (3x скорость)!,", 4000); tutorialStage = 3; } break;
                        case 3: if (abilityActive) { displayTutorialText("Отлично! Стреляйте быстрее пока способность активна!", 3000); enemies.push(createEnemy(WORLD_WIDTH - 200, WORLD_HEIGHT - 200, 'melee', 0, true)); totalEnemies++; tutorialStage = 4; } break;
                        case 4: if (enemies.length === 0) { displayTutorialText("Обучение пройдено! Используйте способность с любым подобранным оружием.", 5000); afterCombat(() => backToMainMenuFromGame(), 5000); tutorialStage = 9; } break;
                    }
                },
                tank: () => {
                    switch(tutorialStage) {
                        case -1: if (Object.values(keys).some(k => k)) { displayTutorialText("Танк готов! Используйте WASD для перемещения."); tutorialStage = 0; } break;
                        case 0: if (keys['w'] || keys['a'] || keys['s'] || keys['d']) { displayTutorialText("Хорошо! Стреляйте ЛКМ по мишеням.", 3000); tutorialStage = 1; } break;
                        case 1:
                            let allHit2 = true;
                            tutorialTargets.forEach(t => { if (!t.hit) allHit2 = false; });
                            if (allHit2) { displayTutorialText("Сейчас появится враг.\nИСПОЛЬЗУЙТЕ ЩИТ (ПКМ) перед боем!", 4000); afterCombat(() => { enemies.push(createEnemy(WORLD_WIDTH - 200, WORLD_HEIGHT - 200, 'ranged', 0, true)); totalEnemies++; }, 4000); tutorialStage = 2; }
                            break;
                        case 2: if (abilityActive) { displayTutorialText("Щит активен! Вы неуязвимы 3 секунды!\nАтакуйте врага!", 3000); tutorialStage = 3; } break;
                        case 3: if (enemies.length === 0) { displayTutorialText("Отлично! Ваш большой запас HP (200) и щит - ваше преимущество!", 5000); afterCombat(() => backToMainMenuFromGame(), 5000); tutorialStage = 9; } break;
                    }
                },
                ammo: () => {
                    switch(tutorialStage) {
                        case -1: if (Object.values(keys).some(k => k)) { displayTutorialText("Стрелок готов! WASD для перемещения."); tutorialStage = 0; } break;
                        case 0: if (keys['w'] || keys['a'] || keys['s'] || keys['d']) { displayTutorialText("Стреляйте ЛКМ. У вас x2 боезапас!", 3000); tutorialStage = 1; } break;
                        case 1:
                            let allHit3 = true;
                            tutorialTargets.forEach(t => { if (!t.hit) allHit3 = false; });
                            if (allHit3) { displayTutorialText("Сейчас враг атакует вас.\nПОЛУЧИТЕ УРОН намеренно!", 3000); enemies.push(createEnemy(WORLD_WIDTH - 200, WORLD_HEIGHT - 200, 'ranged', 0, true)); totalEnemies++; tutorialStage = 2; }
                            break;
                        case 2: if (player.hp < player.maxHP - 30) { displayTutorialText("Теперь ВОССТАНОВИТЕ ЗДОРОВЬЕ!\nНажмите ПКМ для аптечки (+50 HP).", 5000); tutorialStage = 3; } break;
                        case 3: if (medkitUsed) { displayTutorialText("Аптечка использована! 1 раз за уровень.\nПобедите врага!", 3000); tutorialStage = 4; } break;
                        case 4: if (enemies.length === 0) { displayTutorialText("Отлично! x2 боезапас и аптечка - используйте мудро!", 5000); afterCombat(() => backToMainMenuFromGame(), 5000); tutorialStage = 9; } break;
                    }
                },
                machete_char: () => {
                    switch(tutorialStage) {
                        case -1: if (Object.values(keys).some(k => k)) { displayTutorialText("Рубака готов! WASD для перемещения."); tutorialStage = 0; } break;
                        case 0: if (keys['w'] || keys['a'] || keys['s'] || keys['d']) { displayTutorialText("У вас МАЧЕТЕ! Атакуйте ЛКМ вблизи мишеней.", 3000); tutorialStage = 1; } break;
                        case 1:
                            let allHit4 = true;
                            tutorialTargets.forEach(t => { if (!t.hit) allHit4 = false; });
                            if (allHit4) { displayTutorialText("Сейчас появятся враги.\nИСПОЛЬЗУЙТЕ БУЙСТВО (ПКМ)!", 3000); enemies.push(createEnemy(WORLD_WIDTH - 300, WORLD_HEIGHT - 200, 'melee', 0, true)); enemies.push(createEnemy(WORLD_WIDTH - 200, WORLD_HEIGHT - 300, 'melee', 0, true)); totalEnemies += 2; tutorialStage = 2; }
                            break;
                        case 2: if (abilityActive) { displayTutorialText("БУЙСТВО! Радиус удара x2!\nМожете ломать препятствия!\nРубите всех!", 4000); tutorialStage = 3; } break;
                        case 3: if (enemies.length === 0) { displayTutorialText("Кровавая работа! Буйство длится 10 секунд.\nИспользуйте для максимального урона!", 5000); afterCombat(() => backToMainMenuFromGame(), 5000); tutorialStage = 9; } break;
                    }
                },
                pyro: () => {
                    switch (tutorialStage) {
                        case -1:
                            if (Object.values(keys).some(k => k)) {
                                displayTutorialText("Поджигатель готов! Используйте WASD для перемещения.");
                                tutorialStage = 0;
                            }
                            break;
                        case 0:
                            if (keys['w'] || keys['a'] || keys['s'] || keys['d']) {
                                displayTutorialText("Зажмите ЛКМ и сожгите мишени огнеметом!", 3000);
                                tutorialStage = 1;
                            }
                            break;
                        case 1: {
                            let allHit = true;
                            for (const t of tutorialTargets) {
                                if (!t.hit) { allHit = false; break; }
                            }
                            if (allHit) {
                                displayTutorialText("Отлично! Потратьте топливо до 0 — на карте появится +30 топлива (подберите: E).", 4500);
                                tutorialStage = 2;
                            }
                            break;
                        }
                        case 2: {
                            const st = (player.weapon === 'flamethrower') ? currentWeapon : (playerWeaponsState['flamethrower'] || null);
                            const ammoVal = st ? st.ammo : null;
                            if (ammoVal === 0 && flameFuelPickups.length > 0) {
                                displayTutorialText("Топливо появилось! Найдите и подберите +30 (подойдите и нажмите E).", 4000);
                                tutorialStage = 3;
                            }
                            break;
                        }
                        case 3: {
                            const st = (player.weapon === 'flamethrower') ? currentWeapon : (playerWeaponsState['flamethrower'] || null);
                            const ammoVal = st ? st.ammo : null;
                            if (ammoVal !== null && ammoVal > 0) {
                                pyroTutorialStartAmmo = ammoVal;
                                displayTutorialText("Теперь используйте СПОСОБНОСТЬ! Нажмите ПКМ — огненный круг даст урон врагам и восстановит топливо (+10/сек).", 5200);
                                // Spawn one enemy to demonstrate circle damage
                                enemies.push(createEnemy(WORLD_WIDTH - 220, WORLD_HEIGHT - 220, 'melee', 0, true));
                                totalEnemies++;
                                tutorialStage = 4;
                            }
                            break;
                        }
                        case 4:
                            if (pyroAura.active) {
                                displayTutorialText("Круг активен! Подождите пару секунд: топливо должно увеличиться, а враг должен погибнуть.", 4200);
                                tutorialStage = 5;
                            }
                            break;
                        case 5: {
                            const st = (player.weapon === 'flamethrower') ? currentWeapon : (playerWeaponsState['flamethrower'] || null);
                            const ammoVal = st ? st.ammo : null;
                            const ammoOk = (pyroTutorialStartAmmo !== null && ammoVal !== null && ammoVal >= pyroTutorialStartAmmo + 10);
                            const enemyOk = (enemies.length === 0);
                            if (ammoOk && enemyOk) {
                                // Same finish behavior as other classes: short message, then return to main menu
                                displayTutorialText("Обучение пройдено! Комбинируйте огнемет и огненный круг для контроля зоны.", 5000);
                                tutorialStage = 9;
                                afterCombat(() => backToMainMenuFromGame(), 5000);
                            }
                            break;
                        }
                    }
                }
            };

            if (tutorials[selectedCharacter]) tutorials[selectedCharacter]();
        }

        function displayTutorialText(text, duration = 0) { tutorialTextElement.textContent = text; tutorialTextElement.style.display = 'block'; if (duration > 0) afterCombat(() => { if (tutorialTextElement.textContent === text && tutorialStage !== 9) tutorialTextElement.style.display = 'none'; }, duration); }

        function createBoss() { boss = { x: WORLD_WIDTH / 2, y: WORLD_HEIGHT / 2, radius: 40, hp: 2000, maxHP: 2000, phase: 1, attackTimer: 0, attackType: 0, rotation: 0, color: '#ff0000', speed: 1.2, targetX: WORLD_WIDTH / 2, targetY: WORLD_HEIGHT / 2, moveTimer: 0 }; totalEnemies = 1; }

        function createMiniBoss() {
            const side = Math.floor(Math.random() * 4), coords = [[100, WORLD_HEIGHT / 2], [WORLD_WIDTH - 100, WORLD_HEIGHT / 2], [WORLD_WIDTH / 2, 100], [WORLD_WIDTH / 2, WORLD_HEIGHT - 100]][side];
            miniBoss = { x: coords[0], y: coords[1], radius: 15, hp: 1000, maxHP: 1000, attackTimer: 0, attackType: 0, color: '#888888', speed: 2.4, targetX: player.x, targetY: player.y, isDashing: false, dashTimer: 0, isTired: false, tiredTimer: 0, rotation: 0, pathfindTimer: 0, lastX: coords[0], lastY: coords[1], unstuckTimer: 0, walkTimer: 0 };
            document.getElementById('miniBossHealth').style.display = 'block'; updateMiniBossHealthBar(); totalEnemies++;
        }

        function updateMiniBoss() {
            if (!miniBoss) return;

            if (miniBoss.isTired) {
                miniBoss.tiredTimer--;
                if (miniBoss.tiredTimer <= 0) miniBoss.isTired = false;
                return;
            }

            if (miniBoss.isDashing) {
                miniBoss.dashTimer--;
                const angle = Math.atan2(miniBoss.targetY - miniBoss.y, miniBoss.targetX - miniBoss.x);
                const newX = miniBoss.x + Math.cos(angle) * miniBoss.speed * 3;
                const newY = miniBoss.y + Math.sin(angle) * miniBoss.speed * 3;

                GameWorld.moveBody(miniBoss, newX - miniBoss.x, newY - miniBoss.y, walls);

                const dist = Math.hypot(player.x - miniBoss.x, player.y - miniBoss.y);
                if (dist < player.radius + miniBoss.radius) {
                    if (!(abilityActive && selectedCharacter === 'tank')) {
                        player.hp -= 20;
                        updateHUD();
                    }
                }

                for (let i = obstacles.length - 1; i >= 0; i--) {
                    const obs = obstacles[i], obsX = obs.x + obs.width / 2, obsY = obs.y + obs.height / 2;
                    if (Math.hypot(miniBoss.x - obsX, miniBoss.y - obsY) < miniBoss.radius + Math.max(obs.width, obs.height) / 2) {
                        obstacles.splice(i, 1);
                        for (let j = walls.length - 1; j >= 0; j--) {
                            if (walls[j].x === obs.x && walls[j].y === obs.y) {
                                walls.splice(j, 1);
                                break;
                            }
                        }
                    }
                }

                if (miniBoss.dashTimer <= 0) {
                    miniBoss.isDashing = false;
                    miniBoss.isTired = true;
                    miniBoss.tiredTimer = 120;
                }
                return;
            }

            const dist = Math.hypot(player.x - miniBoss.x, player.y - miniBoss.y);
            const optimalDistance = 300;
            const waypoint = navigation.waypoint(miniBoss.x, miniBoss.y, player.x, player.y);
            const angleToPlayer = Math.atan2(waypoint.y - miniBoss.y, waypoint.x - miniBoss.x);

            miniBoss.walkTimer++;
            if (dist > optimalDistance + 80 || !hasLineOfSight(miniBoss.x, miniBoss.y, player.x, player.y)) {
                const newX = miniBoss.x + Math.cos(angleToPlayer) * miniBoss.speed;
                const newY = miniBoss.y + Math.sin(angleToPlayer) * miniBoss.speed;
                GameWorld.moveBody(miniBoss, newX - miniBoss.x, newY - miniBoss.y, walls);
            } else if (dist < optimalDistance - 80) {
                const newX = miniBoss.x - Math.cos(angleToPlayer) * miniBoss.speed;
                const newY = miniBoss.y - Math.sin(angleToPlayer) * miniBoss.speed;
                GameWorld.moveBody(miniBoss, newX - miniBoss.x, newY - miniBoss.y, walls);
            }

            miniBoss.attackTimer++;
            if (miniBoss.attackTimer > 60) {
                miniBoss.attackType = Math.random() < 0.85 ? 0 : 1;
                miniBoss.attackTimer = 0;

                if (miniBoss.attackType === 0) {
                    const angleToPlayer2 = Math.atan2(player.y - miniBoss.y, player.x - miniBoss.x);
                    for (let gun = 0; gun < 2; gun++) {
                        const gunOffset = gun === 0 ? -0.15 : 0.15;
                        for (let i = 0; i < 3; i++) {
                            afterCombat(() => {
                                if (miniBoss) {
                                    enemyBullets.push({
                                        x: miniBoss.x,
                                        y: miniBoss.y,
                                        radius: 6,
                                        speedX: Math.cos(angleToPlayer2 + gunOffset) * 7,
                                        speedY: Math.sin(angleToPlayer2 + gunOffset) * 7,
                                        damage: 15,
                                        color: '#FFD700',
                                        destroyObstacles: true,
                                        bounces: 3
                                    });
                                }
                            }, i * 120 + gun * 60);
                        }
                    }
                } else if (miniBoss.attackType === 1 && dist > 200) {
                    miniBoss.isDashing = true;
                    miniBoss.dashTimer = 25;
                    miniBoss.targetX = player.x;
                    miniBoss.targetY = player.y;
                }
            }

        }

        function updateMiniBossHealthBar() { if (!miniBoss) return; document.getElementById('miniBossHealthFill').style.width = Math.max(0, miniBoss.hp / miniBoss.maxHP) * 100 + '%'; }
        function miniBossDefeated() {
            miniBoss = null;
            document.getElementById('miniBossHealth').style.display = 'none';
            kills++;
            updateHUD();
            if (currentLevel !== 0 && enemies.length === 0 && !boss) {
                levelComplete();
            }
        }

        function createEnemies(level) {
            const roster = Object.entries(Campaign.get(level).mix).flatMap(([type, count]) => Array(count).fill(type));
            // Fixed composition, shuffled roles and balanced spatial distribution.
            for (let i = roster.length - 1; i > 0; i--) {
                const j = Math.floor(levelRandom() * (i + 1));
                [roster[i], roster[j]] = [roster[j], roster[i]];
            }
            const regions = [
                { x: 240, y: 240, width: 1460, height: 760 },
                { x: 1900, y: 240, width: 1460, height: 760 },
                { x: 240, y: 1200, width: 1460, height: 760 },
                { x: 1900, y: 1200, width: 1460, height: 760 }
            ];
            roster.forEach((type, i) => {
                const pos = GameWorld.spawn(navigation, levelRandom, player, 500, enemies, regions[i % 4]) ||
                    GameWorld.spawn(navigation, levelRandom, player, 500, enemies);
                if (pos) enemies.push(createEnemy(pos.x, pos.y, type, level, false));
            });
            totalEnemies = enemies.length; mainEnemiesDefeated = false;
        }

        function createEnemy(x, y, type, level, isTutorialEnemy = false) {
            const data = {
                melee: { color: '#ff8800', speed: (3.5 + level * 0.4) * 1.6, hp: 40 + level * 15, damage: 0.8, radius: 12, groupRange: 200 },
                ranged: { color: '#0088ff', speed: 2.5 * 2, hp: 35 + level * 10, shootInterval: 1500 - level * 100, radius: 11, flankTimer: 0, flankAngle: Math.random() * Math.PI * 2 },
                sniper: { color: '#ff00ff', speed: 1.7 * 2, hp: 30 + level * 8, shootInterval: 2500 - level * 200, radius: 10, range: 800, retreatMode: false },
                tank: { color: '#888888', speed: 1.5 * 2.3, hp: 100 + level * 30, damage: 1.2, radius: 18 },
                // Ambush: fastest chaser, should reliably catch up to the player
                ambush: { color: '#8800ff', speed: (4.8 + level * 0.4) * 1.9, hp: 25 + level * 8, radius: 11, waiting: false, activated: true },

            }[type];
            return { id: enemyIdCounter++, x, y, radius: data.radius, speed: isTutorialEnemy ? 0 : data.speed, hp: data.hp, maxHP: data.hp, type, color: data.color, lastShot: 0, shootInterval: data.shootInterval || 2000, damage: data.damage || 0.5, range: data.range || 600, cone: data.cone || 0, waiting: data.waiting || false, activated: data.activated !== undefined ? data.activated : true, pathfindTimer: 0, targetX: x, targetY: y, stuck: 0, lastX: x, lastY: y, unstuckTimer: 0, groupRange: data.groupRange || 0, flankTimer: data.flankTimer || 0, flankAngle: data.flankAngle || 0, retreatMode: data.retreatMode || false, isTutorialEnemy,

                };
        }

        function getRandomFreePosition(minDistance = 300, occupied = []) {
            ensureNavigation();
            return GameWorld.spawn(navigation, levelRandom, player, minDistance, occupied) ||
                GameWorld.spawn(navigation, levelRandom, player, 0, occupied);
        }

// Helper: prevent enemies from spawning inside walls/obstacles on any level

        function createWeaponPickups(level) {
            const configs = { 1: { shotgun: 2, smg: 1 }, 2: { shotgun: 2, rifle: 1, smg: 1 }, 3: { shotgun: 2, rifle: 1, smg: 1, sniper: 1 }, 4: { shotgun: 2, rifle: 1, smg: 1, sniper: 1 } };
            // One reliable early weapon; the remaining pickups vary between runs.
            const first = GameWorld.spawn(navigation, levelRandom, player, 130, [], { x: 220, y: 60, width: 260, height: 360 });
            if (first) createWeaponPickup('shotgun', first.x, first.y);
            for (const [type, count] of Object.entries(configs[level] || {})) {
                for (let i = 0; i < count - (type === 'shotgun' && first ? 1 : 0); i++) {
                    const pos = getRandomFreePosition(350, weaponPickups);
                    if (pos) createWeaponPickup(type, pos.x, pos.y);
                }
            }
        }

        function createWeaponPickup(weaponType, x, y) {
            let weaponData = { ...weapons[weaponType] };
            if (selectedCharacter === 'ammo' && weaponData.ammo !== Infinity) weaponData.ammo = (weaponData.originalAmmo !== undefined ? weaponData.originalAmmo : weaponData.ammo) * 2;
            weaponPickups.push({ x, y, radius: 20, weaponType, weapon: weaponData });
        }

        function spawnBossWeapon() {
            if (weaponPickups.length >= 8) return;
            const types = ['shotgun', 'rifle', 'smg', 'sniper'], pos = getRandomFreePosition(300, weaponPickups);
            if (pos) createWeaponPickup(types[Math.floor(levelRandom() * types.length)], pos.x, pos.y);
        }

        function spawnFlameFuelPickup(amount = 30) {
            const pos = getRandomFreePosition(500, flameFuelPickups);
            if (pos) flameFuelPickups.push({ ...pos, radius: 18, amount });
        }

        function pickupWeapon() {
            // First: flamethrower fuel
            for (let i = flameFuelPickups.length - 1; i >= 0; i--) {
                const f = flameFuelPickups[i];
                if (Math.hypot(player.x - f.x, player.y - f.y) < player.radius + f.radius + 20) {
                    // Only if the player actually HAS the flamethrower in this run
                    const st = playerWeaponsState['flamethrower'] || (player.weapon === 'flamethrower' ? currentWeapon : null);
                    if (st && st.ammo !== Infinity) {
                        // Cap at 100 (fixed tank size). Always add exactly +30.
                        const gain = 30;
                        st.ammo = Math.min(100, (st.ammo || 0) + gain);
                        // Persist in state
                        playerWeaponsState['flamethrower'] = { ...st };
                        // If currently holding flamethrower, sync currentWeapon too
                        if (player.weapon === 'flamethrower') {
                            currentWeapon.ammo = st.ammo;
                        }
                        flameFuelPickups.splice(i, 1);
                        flameFuelSpawnedThisZero = false;
                        updateHUD();
                        playSound('pew');
                    }
                }
            }

            // Then: normal weapons
            for (let i = weaponPickups.length - 1; i >= 0; i--) {
                const p = weaponPickups[i];
                if (Math.hypot(player.x - p.x, player.y - p.y) < player.radius + p.radius + 20) {
                    // Save pickup weapon state (ammo etc.) and equip
                    playerWeaponsState[p.weaponType] = { ...p.weapon };
                    equipWeapon(p.weaponType);
                    weaponPickups.splice(i, 1);
                    playSound('pew');
                }
            }
        }

        function hasLineOfSight(x1, y1, x2, y2) {
            return GameWorld.clearLine(x1, y1, x2, y2, walls, 5);
        }

        function findPath(enemy) {
            ensureNavigation();
            const dist = Math.hypot(player.x - enemy.x, player.y - enemy.y);
            let target = player;
            if (enemy.type === 'ranged' && hasLineOfSight(enemy.x, enemy.y, player.x, player.y)) {
                enemy.flankTimer++;
                if (enemy.flankTimer > 90) {
                    enemy.flankAngle = Math.atan2(enemy.y - player.y, enemy.x - player.x) + (enemy.id % 2 ? 0.5 : -0.5);
                    enemy.flankTimer = 0;
                }
                const candidate = { x: player.x + Math.cos(enemy.flankAngle) * 300, y: player.y + Math.sin(enemy.flankAngle) * 300 };
                if (!checkWallCollision(candidate.x, candidate.y, 26)) target = candidate;
            }
            enemy.retreatMode = enemy.type === 'sniper' && dist < 400;
            const step = navigation.waypoint(enemy.x, enemy.y, target.x, target.y);
            enemy.targetX = step.x; enemy.targetY = step.y;
        }

        function angleDiff(a, b) {
            let d = a - b;
            while (d > Math.PI) d -= Math.PI * 2;
            while (d < -Math.PI) d += Math.PI * 2;
            return d;
        }

        function shoot() {
            if (!canShoot || gameState !== 'playing' || currentWeapon.ammo <= 0) return;

            const angle = Math.atan2(mouse.worldY - player.y, mouse.worldX - player.x);

            // ===== Flamethrower =====
            if (currentWeapon.type === 'flame') {
                const range = currentWeapon.range || 300;
                const cone = currentWeapon.cone || 0.55; // half-angle

                flameAimAngle = angle;

                // Spawn flame particles (visual)
                const muzzleDist = player.radius + 26;
                const mx = player.x + Math.cos(angle) * muzzleDist;
                const my = player.y + Math.sin(angle) * muzzleDist;

                // More particles and longer travel so the "stream" reads as medium range
                const particleCount = 16;
                for (let i = 0; i < particleCount; i++) {
                    const a = angle + (Math.random() - 0.5) * cone * 2;
                    // push further so flame reaches mid-range visually
                    const sp = 8.8 + Math.random() * 7.2;
                    const life = 18 + Math.floor(Math.random() * 16);
                    const r = 4.5 + Math.random() * 8.5;
                    flameParticles.push({
                        x: mx + (Math.random() - 0.5) * 6,
                        y: my + (Math.random() - 0.5) * 6,
                        vx: Math.cos(a) * sp,
                        vy: Math.sin(a) * sp,
                        r,
                        life,
                        maxLife: life,
                        heat: 0.7 + Math.random() * 0.9
                    });
                }

                // Keep arrays bounded (perf)
                if (flameParticles.length > 380) flameParticles.splice(0, flameParticles.length - 380);

                // Heat spots along most of the stream to convey range (visual only)
                if (Math.random() < 0.85) {
                    const distF = 0.25 + Math.random() * 0.75; // up to near max range
                    const hx = mx + Math.cos(angle) * (30 + distF * range);
                    const hy = my + Math.sin(angle) * (30 + distF * range);
                    flameHeat.push({ x: hx, y: hy, r: 18 + Math.random() * 26, life: 10 + Math.floor(Math.random() * 12), maxLife: 20 });
                    if (flameHeat.length > 90) flameHeat.splice(0, flameHeat.length - 90);
                }

                // Deal damage in a cone (≈30 HP/sec while holding)
                const applyFlameDamage = (target) => {
                    if (!target) return;
                    const dx = target.x - player.x;
                    const dy = target.y - player.y;
                    const dist = Math.hypot(dx, dy);
                    if (dist > range + target.radius || !hasLineOfSight(player.x, player.y, target.x, target.y)) return;
                    const aTo = Math.atan2(dy, dx);
                    if (Math.abs(angleDiff(aTo, angle)) > cone) return;
                    target.hp -= currentWeapon.damage;
                };

                for (let j = enemies.length - 1; j >= 0; j--) {
                    applyFlameDamage(enemies[j]);
                    if (enemies[j].hp <= 0) {
                        enemies.splice(j, 1);
                        kills++;
                    }
                }
                if (miniBoss) {
                    applyFlameDamage(miniBoss);
                    if (miniBoss.hp <= 0) miniBossDefeated();
                    else updateMiniBossHealthBar();
                }
                if (boss) {
                    applyFlameDamage(boss);
                    if (boss.hp <= 0) bossDefeated();
                    else updateBossHealthBar();
                }

                // Tutorial: flamethrower can damage training targets
                if (currentLevel === 0 && tutorialTargets && tutorialTargets.length) {
                    for (const t of tutorialTargets) {
                        if (t.hit) continue;
                        applyFlameDamage(t);
                        if (t.hp <= 0) {
                            t.hit = true;
                            t.color = '#cc0000';
                            playSound('hit_target');
                        }
                    }
                }

                // Consume fuel not every tick (so 100 lasts longer)
                if (currentWeapon.ammo !== Infinity) {
                    currentWeapon._consumeAcc = (currentWeapon._consumeAcc || 0) + 1;
                    const every = Math.max(1, currentWeapon.consumeEvery || 3);
                    if (currentWeapon._consumeAcc >= every) {
                        currentWeapon._consumeAcc = 0;
                        currentWeapon.ammo--;
                        // Spawn fuel pickup once when we hit 0
                        if (currentWeapon.ammo <= 0 && !flameFuelSpawnedThisZero) {
                            flameFuelSpawnedThisZero = true;
                            spawnFlameFuelPickup(30);
                        }
                    }
                }

                playSound(currentWeapon.sound);
                canShoot = false;
                shootCooldown = Math.max(1, Math.ceil(currentWeapon.fireRate * 60 / 1000));
                updateHUD();
                return;
            }

            // ===== Melee =====
            if (currentWeapon.type === 'melee') {
                const effectiveRange = currentWeapon.range;
                enemies.forEach(e => {
                    const dist = Math.hypot(player.x - e.x, player.y - e.y);
                    const angleToEnemy = Math.atan2(e.y - player.y, e.x - player.x);
                    if (dist < player.radius + effectiveRange && Math.abs(angleDiff(angleToEnemy, angle)) < Math.PI / 2 && hasLineOfSight(player.x, player.y, e.x, e.y)) {
                        e.hp -= currentWeapon.damage; e.hitFlash = 5;
                        combatEffects.impact(e.x, e.y, Math.cos(angle), Math.sin(angle), 'body', e.color);
                        if (e.hp <= 0) {
                            enemies.splice(enemies.indexOf(e), 1);
                            kills++;
                            updateHUD();
                        }
                    }
                });

                if (currentLevel === 0) {
                    tutorialTargets.forEach(t => {
                        const dist = Math.hypot(player.x - t.x, player.y - t.y);
                        const angleToTarget = Math.atan2(t.y - player.y, t.x - player.x);
                        if (dist < player.radius + effectiveRange && Math.abs(angleToTarget - angle) < Math.PI / 2 && !t.hit) {
                            t.hp -= currentWeapon.damage;
                            if (t.hp <= 0) {
                                t.hit = true;
                                t.color = '#cc0000';
                                playSound('hit_target');
                            }
                        }
                    });
                }

                if (abilityActive && selectedCharacter === 'machete_char') {
                    for (let i = obstacles.length - 1; i >= 0; i--) {
                        const obs = obstacles[i];
                        const obsX = obs.x + obs.width / 2;
                        const obsY = obs.y + obs.height / 2;
                        const dist = Math.hypot(player.x - obsX, player.y - obsY);
                        const angleToObs = Math.atan2(obsY - player.y, obsX - player.x);
                        if (dist < player.radius + effectiveRange + Math.max(obs.width, obs.height) / 2 && Math.abs(angleToObs - angle) < Math.PI / 2) {
                            obstacles.splice(i, 1);
                            for (let j = walls.length - 1; j >= 0; j--) {
                                if (walls[j].x === obs.x && walls[j].y === obs.y && walls[j].width === obs.width && walls[j].height === obs.height) {
                                    walls.splice(j, 1);
                                    break;
                                }
                            }
                        }
                    }
                }

                macheteSlash = { x: player.x, y: player.y, angle, radius: player.radius + effectiveRange, duration: 10 };
            } else {
                // ===== Ranged: cosmetic feedback does not change fire rate or damage. =====
                let mx = player.x + Math.cos(angle) * (player.radius + 24);
                let my = player.y + Math.sin(angle) * (player.radius + 24);
                if (!GameWorld.clearLine(player.x, player.y, mx, my, walls, 5)) { mx = player.x; my = player.y; }
                muzzleFlashes.push({ x: mx, y: my, angle, life: 4, maxLife: 4 });
                if (muzzleFlashes.length > 24) muzzleFlashes.shift();
                const pellets = currentWeapon.spread || 1;
                for (let i = 0; i < pellets; i++) {
                    const a = angle + (pellets > 1 ? (i - (pellets - 1) / 2) * 0.1 : 0);
                    bullets.push({ x: mx, y: my, radius: 5,
                        speedX: Math.cos(a) * currentWeapon.bulletSpeed,
                        speedY: Math.sin(a) * currentWeapon.bulletSpeed,
                        damage: currentWeapon.damage, color: currentWeapon.color,
                        pierce: player.weapon === 'sniper' && Math.random() < 0.5 ? 1 : 0,
                        hitIds: new Set() });
                }
            }

            if (currentWeapon.ammo !== Infinity) currentWeapon.ammo--;
            playSound(currentWeapon.sound);
            canShoot = false;
            shootCooldown = Math.max(1, Math.ceil(currentWeapon.fireRate * 60 / 1000));
            updateHUD();
        }

        function updateBoss() {
            if (!boss) return;
            boss.rotation += 0.02; boss.attackTimer++; boss.moveTimer++;
            boss.phase = boss.hp < boss.maxHP * 0.25 ? 4 : boss.hp < boss.maxHP * 0.5 ? 3 : boss.hp < boss.maxHP * 0.75 ? 2 : 1;
            if (boss.moveTimer > 180) { boss.targetX = 400 + Math.random() * (WORLD_WIDTH - 800); boss.targetY = 400 + Math.random() * (WORLD_HEIGHT - 800); boss.moveTimer = 0; }
            const dx = boss.targetX - boss.x, dy = boss.targetY - boss.y, dist = Math.hypot(dx, dy);
            if (dist > 10) { boss.x += (dx / dist) * boss.speed; boss.y += (dy / dist) * boss.speed; }
            const attackSpeed = boss.phase === 4 ? 40 : boss.phase === 3 ? 50 : 60;
            if (boss.attackTimer > attackSpeed) {
                boss.attackType = Math.floor(Math.random() * 5); boss.attackTimer = 0;
                const attacks = [
                    () => { const bulletCount = 8 + boss.phase * 4; for (let i = 0; i < bulletCount; i++) { const angle = (Math.PI * 2 / bulletCount) * i + boss.rotation; enemyBullets.push({ x: boss.x, y: boss.y, radius: 6, speedX: Math.cos(angle) * 5, speedY: Math.sin(angle) * 5, damage: 15, color: '#ff0000' }); } },
                    () => { const playerAngle = Math.atan2(player.y - boss.y, player.x - boss.x); for (let i = -3; i <= 3; i++) { const spreadAngle = playerAngle + i * 0.15; enemyBullets.push({ x: boss.x, y: boss.y, radius: 8, speedX: Math.cos(spreadAngle) * 9, speedY: Math.sin(spreadAngle) * 9, damage: 20, color: '#ff6600' }); } },
                    () => { for (let i = 0; i < 4; i++) { const mX = boss.x + (Math.random() - 0.5) * 400, mY = boss.y + (Math.random() - 0.5) * 400; afterCombat(() => enemyBullets.push({ x: mX, y: mY, radius: 15, speedX: 0, speedY: 0, damage: 25, color: '#ff00ff', mine: true, timer: 90 }), i * 150); } },
                    () => { for (let wave = 0; wave < 3; wave++) afterCombat(() => { for (let i = 0; i < 6; i++) { const angle = (Math.PI * 2 / 6) * i; enemyBullets.push({ x: boss.x, y: boss.y, radius: 5, speedX: Math.cos(angle) * (4 + wave), speedY: Math.sin(angle) * (4 + wave), damage: 12, color: '#00ffff' }); } }, wave * 200); },
                    () => { for (let i = 0; i < 3; i++) afterCombat(() => { const angleToPlayer = Math.atan2(player.y - boss.y, player.x - boss.x); enemyBullets.push({ x: boss.x, y: boss.y, radius: 10, speedX: Math.cos(angleToPlayer) * 7, speedY: Math.sin(angleToPlayer) * 7, damage: 30, color: '#ffff00', homing: true }); }, i * 300); }
                ];
                attacks[boss.attackType]();
            }
        }

        function updateBossHealthBar() { if (!boss) return; document.getElementById('bossHealthFill').style.width = Math.max(0, boss.hp / boss.maxHP) * 100 + '%'; }
        function bossDefeated() {
            boss = null;
            // In HARD-MODE the boss is the final step: finish the run properly.
            if (hardMode) {
                // Force progress to the last stage so hard-mode completion triggers.
                hardModeProgress = Math.max(hardModeProgress, 5);
                levelComplete();
                return;
            }

            gameState = 'complete';
            stopMusic();
            stopAllHtmlMusic(true);
            afterSession(() => {
                showGameAlert('🎉 BIG-BOB ПОБЕЖДЕН!\n\nВы спасли мир от этого монстра!\n\nОтличная работа!', 'Победа над боссом').then(() => backToMainMenuFromGame());
            }, 100);
        }

        function updatePlayerProjectiles() {
            for (let i = bullets.length - 1; i >= 0; i--) {
                const b = bullets[i], x = b.x, y = b.y;
                const tx = x + b.speedX, ty = y + b.speedY;
                b.hitIds ||= new Set();
                let wallTime = 2;
                for (const wall of walls) {
                    const t = GameWorld.segmentRect(x, y, tx, ty, wall, b.radius);
                    if (t !== null) wallTime = Math.min(wallTime, t);
                }
                const candidates = [...enemies];
                if (boss) candidates.push(boss);
                if (miniBoss) candidates.push(miniBoss);
                if (currentLevel === 0) candidates.push(...tutorialTargets.filter(t => !t.hit));
                const hits = candidates.filter(t => !b.hitIds.has(t)).map(target => ({ target,
                    time: GameWorld.segmentCircle(x, y, tx, ty, target, b.radius) }))
                    .filter(h => h.time !== null && h.time < wallTime).sort((a, b) => a.time - b.time);
                let end = Math.min(1, wallTime), consumed = wallTime <= 1;
                for (const hit of hits) {
                    const target = hit.target;
                    b.hitIds.add(target);
                    target.hp -= b.damage; target.hitFlash = 5;
                    const hx = x + (tx - x) * hit.time, hy = y + (ty - y) * hit.time;
                    combatEffects.impact(hx, hy, b.speedX, b.speedY, 'body', target.color || b.color);
                    if (tutorialTargets.includes(target)) {
                        if (target.hp <= 0) { target.hit = true; target.color = '#cc0000'; playSound('hit_target'); }
                    } else if (target === boss) {
                        if (target.hp <= 0) bossDefeated(); else updateBossHealthBar();
                    } else if (target === miniBoss) {
                        if (target.hp <= 0) miniBossDefeated(); else updateMiniBossHealthBar();
                    } else if (target.hp <= 0) {
                        const index = enemies.indexOf(target);
                        if (index >= 0) { enemies.splice(index, 1); kills++; updateHUD(); }
                    }
                    if (b.pierce > 0) b.pierce--;
                    else { end = hit.time; consumed = true; break; }
                }
                b.x = x + (tx - x) * end; b.y = y + (ty - y) * end;
                combatEffects.trace(x, y, b.x, b.y, b.color);
                if (wallTime <= 1 && end === wallTime) combatEffects.impact(b.x, b.y, b.speedX, b.speedY);
                if (consumed || b.x < 0 || b.x > WORLD_WIDTH || b.y < 0 || b.y > WORLD_HEIGHT) bullets.splice(i, 1);
            }
        }

        function update() {
            if (gameState !== 'playing') return;
            simulationTime += 1000 / 60;
            const pending = combatTimers; combatTimers = [];
            for (const timer of pending) {
                if (--timer.frames <= 0) timer.callback(); else combatTimers.push(timer);
                if (gameState !== 'playing') return;
            }
            ensureNavigation();
            combatEffects.update();
            if (shootCooldown > 0 && --shootCooldown === 0) canShoot = true;

            if (currentLevel === 0) {
                updateTutorial();
            }
            updateAbility();
            updateAmbient();
            updateFlame();

            // Update muzzle flashes (visual only)
            if (muzzleFlashes.length) {
                for (let i = muzzleFlashes.length - 1; i >= 0; i--) {
                    muzzleFlashes[i].life--;
                    if (muzzleFlashes[i].life <= 0) muzzleFlashes.splice(i, 1);
                }
            }

            // Pyro ability effects (damage + ammo regen)
            if (selectedCharacter === 'pyro' && pyroAura.active) {
                pyroAura.t += 1;

                // Spawn a few ring sparks (visual only, lightweight)
                if (pyroAura.t % 3 === 0) {
                    const base = Math.random() * Math.PI * 2;
                    for (let k = 0; k < 2; k++) {
                        const a = base + (k ? 0.18 : -0.18);
                        const rr = pyroAura.radius + 6 + Math.random() * 10;
                        const x = player.x + Math.cos(a) * rr;
                        const y = player.y + Math.sin(a) * rr;
                        const sp = 2.0 + Math.random() * 2.6;
                        const life = 14 + Math.floor(Math.random() * 10);
                        flameParticles.push({
                            x,
                            y,
                            vx: Math.cos(a) * sp + (Math.random() - 0.5) * 1.2,
                            vy: Math.sin(a) * sp + (Math.random() - 0.5) * 1.2,
                            r: 3.0 + Math.random() * 4.0,
                            life,
                            maxLife: life,
                            heat: 0.9 + Math.random() * 0.6
                        });
                    }
                    if (flameParticles.length > 380) flameParticles.splice(0, flameParticles.length - 380);
                }
                // damage enemies inside circle (continuous)
                const dmg = pyroAura.dps / 60;
                for (let i = enemies.length - 1; i >= 0; i--) {
                    const e = enemies[i];
                    if (Math.hypot(e.x - player.x, e.y - player.y) <= pyroAura.radius + e.radius) {
                        e.hp -= dmg;
                        if (e.hp <= 0) {
                            enemies.splice(i, 1);
                            kills++;
                        }
                    }
                }
                if (miniBoss && Math.hypot(miniBoss.x - player.x, miniBoss.y - player.y) <= pyroAura.radius + miniBoss.radius) {
                    miniBoss.hp -= dmg;
                    if (miniBoss.hp <= 0) miniBossDefeated();
                    else updateMiniBossHealthBar();
                }
                if (boss && Math.hypot(boss.x - player.x, boss.y - player.y) <= pyroAura.radius + boss.radius) {
                    boss.hp -= dmg;
                    if (boss.hp <= 0) bossDefeated();
                    else updateBossHealthBar();
                }

                // fuel regen every second while aura is active
                pyroAura.tickAcc += 1 / 60;
                if (pyroAura.tickAcc >= 1) {
                    pyroAura.tickAcc = 0;
                    const st = playerWeaponsState['flamethrower'] || (player.weapon === 'flamethrower' ? currentWeapon : null);
                    if (st && st.ammo !== Infinity) {
                        st.ammo = Math.min(100, (st.ammo || 0) + pyroAura.ammoPerSec);
                        playerWeaponsState['flamethrower'] = { ...st };
                        if (player.weapon === 'flamethrower') currentWeapon.ammo = st.ammo;
                        // if we were at 0, allow next pickup spawn later
                        if (st.ammo > 0) flameFuelSpawnedThisZero = false;
                        updateHUD();
                    }
                }
            }

            let newX = player.x, newY = player.y;
            if (keys['w']) newY -= player.speed; if (keys['s']) newY += player.speed; if (keys['a']) newX -= player.speed; if (keys['d']) newX += player.speed;

            {
                GameWorld.moveBody(player, newX - player.x, newY - player.y, walls);
                player.x = Math.max(player.radius, Math.min(WORLD_WIDTH - player.radius, player.x));
                player.y = Math.max(player.radius, Math.min(WORLD_HEIGHT - player.radius, player.y));
            }
            camera.x = Math.max(0, Math.min(player.x - canvas.width / 2, WORLD_WIDTH - canvas.width));
            camera.y = Math.max(0, Math.min(player.y - canvas.height / 2, WORLD_HEIGHT - canvas.height));

            if (reducedMotion.matches) camera.shakeDuration = 0;
            if (camera.shakeDuration > 0) {
                const p = camera.shakePower || 10;
                camera.shakeX = (Math.random() - 0.5) * p;
                camera.shakeY = (Math.random() - 0.5) * p;
                camera.shakeDuration--;
                // ease out power slightly
                camera.shakePower = Math.max(6, p * 0.96);
            } else {
                camera.shakeX = 0;
                camera.shakeY = 0;
                camera.shakePower = 10;
            }

            const hpPercent = (player.hp / player.maxHP) * 100;
            const threshold = Math.floor(hpPercent / 20) * 20;
            if (threshold < player.lastHpThreshold) {
                camera.shakeDuration = 15;
                player.lastHpThreshold = threshold;
            }

            mouse.worldX = mouse.x + camera.x; mouse.worldY = mouse.y + camera.y;
            if (mouse.clicked) shoot();
            if (macheteSlash) { macheteSlash.duration--; if (macheteSlash.duration <= 0) macheteSlash = null; }
            if (boss) { updateBoss(); weaponSpawnTimer++; if (weaponSpawnTimer > 300) { spawnBossWeapon(); weaponSpawnTimer = 0; } }

            updatePlayerProjectiles();
            if (gameState !== 'playing') return;

            for (let i = enemies.length - 1; i >= 0; i--) {
                const e = enemies[i];
                if (e.hitFlash > 0) e.hitFlash--;
                const dist = Math.hypot(player.x - e.x, player.y - e.y);
                findPath(e);
                if (e.isTutorialEnemy && tutorialStage < 4) e.speed = 0;
                else if (e.isTutorialEnemy && tutorialStage >= 4) e.speed = (3.5 + currentLevel * 0.4) * 2;
                const angleToTarget = Math.atan2(e.targetY - e.y, e.targetX - e.x);
                if (e.type === 'melee' || e.type === 'tank' || e.type === 'ambush') {
                    let newX = e.x + Math.cos(angleToTarget) * e.speed;
                    let newY = e.y + Math.sin(angleToTarget) * e.speed;

                    GameWorld.moveBody(e, newX - e.x, newY - e.y, walls);
                    if (dist < player.radius + e.radius && !(abilityActive && selectedCharacter === 'tank')) { player.hp -= e.damage; updateHUD(); }
                } else if (e.type === 'ranged' || e.type === 'sniper') {
                    const optimalDistance = e.type === 'sniper' ? 500 : 250;
                    if (!hasLineOfSight(e.x, e.y, player.x, player.y) || !e.retreatMode && dist > optimalDistance + 50) {
                        let newX = e.x + Math.cos(angleToTarget) * e.speed;
                        let newY = e.y + Math.sin(angleToTarget) * e.speed;

                        GameWorld.moveBody(e, newX - e.x, newY - e.y, walls);
                    }
                    else if (e.retreatMode || dist < optimalDistance - 50) {
                        const away = Math.atan2(e.y - player.y, e.x - player.x);
                        let newX = e.x + Math.cos(away) * e.speed;
                        let newY = e.y + Math.sin(away) * e.speed;

                        GameWorld.moveBody(e, newX - e.x, newY - e.y, walls);
                    }
                    const now = simulationTime;
                    if (now - e.lastShot > e.shootInterval && dist < e.range && hasLineOfSight(e.x, e.y, player.x, player.y)) {
                        const angleToPlayer = Math.atan2(player.y - e.y, player.x - e.x);

                        if (e.type === 'sniper') {
                            // Sniper: high-speed bullet that can bounce up to 2 times
                            const bulletSpeed = 12;
                            enemyBullets.push({
                                x: e.x,
                                y: e.y,
                                radius: 6,
                                speedX: Math.cos(angleToPlayer) * bulletSpeed,
                                speedY: Math.sin(angleToPlayer) * bulletSpeed,
                                damage: 20,
                                color: '#ff00ff',
                                bounces: 2
                            });
                        } else {
                            // Ranged: "ability" – 2-3 projectiles in different directions (fan spread)
                            const bulletSpeed = 6;
                            const count = Math.random() < 0.55 ? 2 : 3;
                            const spread = 0.22;
                            const center = angleToPlayer + (Math.random() - 0.5) * 0.06;

                            for (let k = 0; k < count; k++) {
                                const off = (k - (count - 1) / 2) * spread;
                                const a = center + off;
                                enemyBullets.push({
                                    x: e.x,
                                    y: e.y,
                                    radius: 4,
                                    speedX: Math.cos(a) * bulletSpeed,
                                    speedY: Math.sin(a) * bulletSpeed,
                                    damage: 12,
                                    color: '#ff0000'
                                });
                            }
                        }

                        e.lastShot = now;
                    }
                }
            }

            for (let i = enemyBullets.length - 1; i >= 0; i--) {
                const b = enemyBullets[i];
                if (b.mine) { b.timer--; if (b.timer <= 0) { for (let j = 0; j < 8; j++) { const angle = (Math.PI * 2 / 8) * j; enemyBullets.push({ x: b.x, y: b.y, radius: 4, speedX: Math.cos(angle) * 6, speedY: Math.sin(angle) * 6, damage: 10, color: '#ff00ff' }); } enemyBullets.splice(i, 1); continue; } }
                else {
                    if (b.homing) { const angleToPlayer = Math.atan2(player.y - b.y, player.x - b.x); b.speedX += Math.cos(angleToPlayer) * 0.15; b.speedY += Math.sin(angleToPlayer) * 0.15; const speed = Math.hypot(b.speedX, b.speedY); if (speed > 8) { b.speedX = (b.speedX / speed) * 8; b.speedY = (b.speedY / speed) * 8; } }
                    const px = b.x, py = b.y;
                    b.x += b.speedX; b.y += b.speedY;
                    combatEffects.trace(px, py, b.x, b.y, b.color, true);
                    if (b.destroyObstacles) for (let j = obstacles.length - 1; j >= 0; j--) { const obs = obstacles[j], obsX = obs.x + obs.width / 2, obsY = obs.y + obs.height / 2; if (Math.hypot(b.x - obsX, b.y - obsY) < b.radius + Math.max(obs.width, obs.height) / 2) { obstacles.splice(j, 1); for (let k = walls.length - 1; k >= 0; k--) if (walls[k].x === obs.x && walls[k].y === obs.y) { walls.splice(k, 1); break; } } }
                }
                if (b.bounces !== undefined && b.bounces > 0 && checkWallCollision(b.x, b.y, b.radius)) { b.bounces--; if (b.x <= b.radius || b.x >= WORLD_WIDTH - b.radius) b.speedX *= -1; if (b.y <= b.radius || b.y >= WORLD_HEIGHT - b.radius) b.speedY *= -1; let hitWall = false; for (let w of walls) { const closestX = Math.max(w.x, Math.min(b.x, w.x + w.width)), closestY = Math.max(w.y, Math.min(b.y, w.y + w.height)); if (Math.hypot(b.x - closestX, b.y - closestY) < b.radius) { const nx = b.x - closestX, ny = b.y - closestY, len = Math.hypot(nx, ny); if (len > 0) { const nxNorm = nx / len, nyNorm = ny / len, dot = b.speedX * nxNorm + b.speedY * nyNorm; b.speedX -= 2 * dot * nxNorm; b.speedY -= 2 * dot * nyNorm; } hitWall = true; break; } } if (!hitWall && (b.x < 0 || b.x > WORLD_WIDTH || b.y < 0 || b.y > WORLD_HEIGHT)) { enemyBullets.splice(i, 1); continue; } } else if (b.x < 0 || b.x > WORLD_WIDTH || b.y < 0 || b.y > WORLD_HEIGHT || checkWallCollision(b.x, b.y, b.radius)) { enemyBullets.splice(i, 1); continue; }
                if (Math.hypot(b.x - player.x, b.y - player.y) < b.radius + player.radius) {
                    if (!(abilityActive && selectedCharacter === 'tank')) {
                        player.hp -= b.damage;
                        updateHUD();
                    }
                    enemyBullets.splice(i, 1);
                }
            }

            if (currentLevel === 4 && enemies.length === 0 && !miniBoss && !mainEnemiesDefeated) {
                mainEnemiesDefeated = true;
                createMiniBoss();
                // Keep current HTML track (HQ) playing; do not start synth music overlays
            }
            if (miniBoss) updateMiniBoss();

            if (player.hp <= 0) { gameOver(); return; }

            // Level complete logic:
            if (currentLevel !== 0 && enemies.length === 0 && !boss && !miniBoss) {
                {
                    levelComplete();
                }
            }
        }

        function checkWallCollision(x, y, radius) {
            return GameWorld.circleBlocked(x, y, radius, walls);
        }

        function drawWeapon(x, y, type, scale = 1) {
            ctx.save();
            ctx.translate(x, y);
            ctx.scale(0.6 * scale, 0.6 * scale);

            // Subtle depth (no neon glow, more "realistic" silhouettes)
            ctx.shadowBlur = 6;
            ctx.shadowColor = 'rgba(0,0,0,0.35)';

            const metal = (x0, y0, x1, y1) => {
                const g = ctx.createLinearGradient(x0, y0, x1, y1);
                g.addColorStop(0, '#0f1215');
                g.addColorStop(0.25, '#2a2f36');
                g.addColorStop(0.55, '#4b5560');
                g.addColorStop(0.8, '#22272e');
                g.addColorStop(1, '#0b0d10');
                return g;
            };
            const parker = (x0, y0, x1, y1) => {
                const g = ctx.createLinearGradient(x0, y0, x1, y1);
                g.addColorStop(0, '#0d0f12');
                g.addColorStop(0.45, '#1a1f26');
                g.addColorStop(1, '#060709');
                return g;
            };
            const wood = (x0, y0, x1, y1) => {
                const g = ctx.createLinearGradient(x0, y0, x1, y1);
                g.addColorStop(0, '#6b3f1f');
                g.addColorStop(0.5, '#8b552b');
                g.addColorStop(1, '#4e2d16');
                return g;
            };

            const strokeSoft = () => {
                ctx.lineWidth = 1.4;
                ctx.strokeStyle = 'rgba(255,255,255,0.14)';
                ctx.stroke();
                ctx.lineWidth = 2;
                ctx.strokeStyle = 'rgba(0,0,0,0.55)';
                ctx.stroke();
            };

            const shapes = {
                pistol: () => {
                    // Slide
                    ctx.fillStyle = metal(-22, -10, 26, 10);
                    ctx.beginPath();
                    ctx.roundRect(-18, -7, 36, 14, 4);
                    ctx.fill();
                    strokeSoft();

                    // Barrel/muzzle
                    ctx.fillStyle = parker(18, -6, 38, 6);
                    ctx.beginPath();
                    ctx.roundRect(16, -4, 14, 8, 3);
                    ctx.fill();
                    ctx.fillStyle = '#0a0a0a';
                    ctx.beginPath();
                    ctx.arc(30, 0, 2.4, 0, Math.PI * 2);
                    ctx.fill();

                    // Frame
                    ctx.fillStyle = parker(-20, -10, 22, 12);
                    ctx.beginPath();
                    ctx.roundRect(-16, -2, 30, 10, 3);
                    ctx.fill();
                    strokeSoft();

                    // Trigger guard
                    ctx.strokeStyle = 'rgba(0,0,0,0.75)';
                    ctx.lineWidth = 3;
                    ctx.beginPath();
                    ctx.roundRect(-2, 2, 10, 8, 4);
                    ctx.stroke();

                    // Grip
                    ctx.save();
                    ctx.translate(-6, 7);
                    ctx.rotate(0.28);
                    ctx.fillStyle = '#15181d';
                    ctx.beginPath();
                    ctx.roundRect(-8, 0, 14, 18, 4);
                    ctx.fill();
                    ctx.lineWidth = 2;
                    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
                    ctx.stroke();
                    // grip texture
                    ctx.globalAlpha = 0.18;
                    ctx.strokeStyle = '#fff';
                    ctx.lineWidth = 1;
                    for (let i = 2; i < 16; i += 3) {
                        ctx.beginPath();
                        ctx.moveTo(-7, i);
                        ctx.lineTo(5, i - 2);
                        ctx.stroke();
                    }
                    ctx.restore();

                    // Rear sight
                    ctx.fillStyle = '#0a0a0a';
                    ctx.fillRect(-16, -10, 6, 4);
                    // Ejection port highlight
                    ctx.globalAlpha = 0.25;
                    ctx.fillStyle = '#cbd5e1';
                    ctx.fillRect(0, -5, 9, 2);
                    ctx.globalAlpha = 1;
                },

                shotgun: () => {
                    // Barrel
                    ctx.fillStyle = metal(-40, -8, 60, 8);
                    ctx.beginPath();
                    ctx.roundRect(-26, -4, 66, 8, 3);
                    ctx.fill();
                    strokeSoft();

                    // Muzzle cap
                    ctx.fillStyle = '#0a0a0a';
                    ctx.beginPath();
                    ctx.roundRect(40, -3, 10, 6, 3);
                    ctx.fill();

                    // Receiver
                    ctx.fillStyle = parker(-20, -10, 24, 10);
                    ctx.beginPath();
                    ctx.roundRect(-18, -7, 26, 14, 4);
                    ctx.fill();
                    strokeSoft();

                    // Pump/handguard
                    ctx.fillStyle = '#2b2b2b';
                    ctx.beginPath();
                    ctx.roundRect(0, -6, 20, 12, 4);
                    ctx.fill();
                    ctx.globalAlpha = 0.20;
                    ctx.fillStyle = '#fff';
                    for (let i = 2; i < 18; i += 4) ctx.fillRect(i, -5, 1, 10);
                    ctx.globalAlpha = 1;

                    // Trigger guard
                    ctx.strokeStyle = 'rgba(0,0,0,0.75)';
                    ctx.lineWidth = 3;
                    ctx.beginPath();
                    ctx.roundRect(-6, 1, 10, 8, 4);
                    ctx.stroke();

                    // Stock (wood)
                    ctx.fillStyle = wood(-60, -20, -10, 20);
                    ctx.beginPath();
                    ctx.moveTo(-18, -6);
                    ctx.lineTo(-44, -18);
                    ctx.lineTo(-56, -10);
                    ctx.lineTo(-56, 10);
                    ctx.lineTo(-44, 18);
                    ctx.lineTo(-18, 6);
                    ctx.closePath();
                    ctx.fill();
                    ctx.lineWidth = 2;
                    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
                    ctx.stroke();
                },

                rifle: () => {
                    // Barrel + handguard
                    ctx.fillStyle = metal(-48, -10, 72, 10);
                    ctx.beginPath();
                    ctx.roundRect(-28, -3, 82, 6, 3);
                    ctx.fill();
                    strokeSoft();

                    // Gas block / front sight
                    ctx.fillStyle = '#101214';
                    ctx.beginPath();
                    ctx.roundRect(35, -7, 8, 14, 2);
                    ctx.fill();

                    // Receiver
                    ctx.fillStyle = parker(-22, -12, 30, 12);
                    ctx.beginPath();
                    ctx.roundRect(-18, -7, 30, 14, 4);
                    ctx.fill();
                    strokeSoft();

                    // Top rail
                    ctx.globalAlpha = 0.35;
                    ctx.fillStyle = '#cbd5e1';
                    ctx.fillRect(-10, -9, 26, 2);
                    ctx.globalAlpha = 1;

                    // Magazine
                    ctx.save();
                    ctx.translate(4, 6);
                    ctx.rotate(0.10);
                    ctx.fillStyle = '#121418';
                    ctx.beginPath();
                    ctx.roundRect(-3, 0, 9, 16, 3);
                    ctx.fill();
                    ctx.lineWidth = 2;
                    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
                    ctx.stroke();
                    ctx.restore();

                    // Grip
                    ctx.save();
                    ctx.translate(-2, 5);
                    ctx.rotate(0.35);
                    ctx.fillStyle = '#15181d';
                    ctx.beginPath();
                    ctx.roundRect(-6, 0, 10, 14, 3);
                    ctx.fill();
                    ctx.restore();

                    // Stock
                    ctx.fillStyle = '#1a1d22';
                    ctx.beginPath();
                    ctx.roundRect(-40, -6, 22, 12, 4);
                    ctx.fill();
                    ctx.lineWidth = 2;
                    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
                    ctx.stroke();
                },

                smg: () => {
                    // Barrel
                    ctx.fillStyle = metal(-22, -10, 70, 10);
                    ctx.beginPath();
                    ctx.roundRect(20, -3, 28, 6, 3);
                    ctx.fill();

                    // Receiver
                    ctx.fillStyle = parker(-32, -14, 34, 14);
                    ctx.beginPath();
                    ctx.roundRect(-18, -8, 40, 16, 4);
                    ctx.fill();
                    strokeSoft();

                    // Ejection/upper highlight
                    ctx.globalAlpha = 0.18;
                    ctx.fillStyle = '#e5e7eb';
                    ctx.fillRect(-8, -6, 22, 2);
                    ctx.globalAlpha = 1;

                    // Magazine (straight)
                    ctx.fillStyle = '#121418';
                    ctx.beginPath();
                    ctx.roundRect(-2, 6, 8, 18, 2);
                    ctx.fill();
                    ctx.lineWidth = 2;
                    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
                    ctx.stroke();

                    // Grip
                    ctx.save();
                    ctx.translate(8, 6);
                    ctx.rotate(0.40);
                    ctx.fillStyle = '#15181d';
                    ctx.beginPath();
                    ctx.roundRect(-6, 0, 10, 14, 3);
                    ctx.fill();
                    ctx.restore();

                    // Stock (simple)
                    ctx.fillStyle = '#111317';
                    ctx.beginPath();
                    ctx.roundRect(-34, -4, 16, 8, 3);
                    ctx.fill();
                    ctx.beginPath();
                    ctx.roundRect(-44, -2, 12, 4, 2);
                    ctx.fill();
                },

                sniper: () => {
                    // Barrel
                    ctx.fillStyle = metal(-60, -10, 100, 10);
                    ctx.beginPath();
                    ctx.roundRect(-30, -2, 90, 4, 2);
                    ctx.fill();
                    strokeSoft();

                    // Muzzle brake
                    ctx.fillStyle = '#0a0a0a';
                    ctx.beginPath();
                    ctx.roundRect(60, -3, 10, 6, 2);
                    ctx.fill();
                    ctx.globalAlpha = 0.35;
                    ctx.fillStyle = '#cbd5e1';
                    ctx.fillRect(62, -2, 2, 4);
                    ctx.fillRect(66, -2, 2, 4);
                    ctx.globalAlpha = 1;

                    // Receiver
                    ctx.fillStyle = parker(-26, -14, 34, 14);
                    ctx.beginPath();
                    ctx.roundRect(-18, -6, 34, 12, 4);
                    ctx.fill();
                    strokeSoft();

                    // Scope
                    ctx.fillStyle = '#14171b';
                    ctx.beginPath();
                    ctx.roundRect(-6, -14, 30, 6, 3);
                    ctx.fill();
                    ctx.fillStyle = '#0a0a0a';
                    ctx.beginPath();
                    ctx.roundRect(-10, -15, 6, 8, 3);
                    ctx.fill();
                    ctx.beginPath();
                    ctx.roundRect(24, -15, 6, 8, 3);
                    ctx.fill();
                    ctx.globalAlpha = 0.18;
                    ctx.fillStyle = '#e5e7eb';
                    ctx.fillRect(-4, -13, 24, 2);
                    ctx.globalAlpha = 1;

                    // Stock
                    ctx.fillStyle = '#1b1f26';
                    ctx.beginPath();
                    ctx.moveTo(-18, -5);
                    ctx.lineTo(-52, -14);
                    ctx.lineTo(-60, -8);
                    ctx.lineTo(-60, 8);
                    ctx.lineTo(-52, 14);
                    ctx.lineTo(-18, 5);
                    ctx.closePath();
                    ctx.fill();
                    ctx.lineWidth = 2;
                    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
                    ctx.stroke();

                    // Bipod
                    ctx.globalAlpha = 0.75;
                    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
                    ctx.lineWidth = 2;
                    ctx.beginPath();
                    ctx.moveTo(18, 2);
                    ctx.lineTo(10, 14);
                    ctx.moveTo(22, 2);
                    ctx.lineTo(28, 14);
                    ctx.stroke();
                    ctx.globalAlpha = 1;
                },

                machete: () => {
                    // Handle
                    ctx.fillStyle = '#1a1a1a';
                    ctx.beginPath();
                    ctx.roundRect(-18, -5, 18, 10, 4);
                    ctx.fill();
                    ctx.lineWidth = 2;
                    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
                    ctx.stroke();

                    // Guard
                    ctx.fillStyle = metal(-10, -8, 10, 8);
                    ctx.beginPath();
                    ctx.roundRect(-2, -7, 6, 14, 3);
                    ctx.fill();

                    // Blade (metal)
                    const g = ctx.createLinearGradient(0, -10, 70, 10);
                    g.addColorStop(0, '#2b2f36');
                    g.addColorStop(0.35, '#cbd5e1');
                    g.addColorStop(1, '#1b1f26');
                    ctx.fillStyle = g;
                    ctx.beginPath();
                    ctx.moveTo(2, -5);
                    ctx.lineTo(70, -10);
                    ctx.lineTo(64, 10);
                    ctx.lineTo(2, 5);
                    ctx.closePath();
                    ctx.fill();
                    ctx.lineWidth = 2;
                    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
                    ctx.stroke();

                    // Edge highlight
                    ctx.globalAlpha = 0.25;
                    ctx.strokeStyle = '#ffffff';
                    ctx.lineWidth = 1;
                    ctx.beginPath();
                    ctx.moveTo(10, -3);
                    ctx.lineTo(66, -8);
                    ctx.stroke();
                    ctx.globalAlpha = 1;
                },

                flamethrower: () => {
                    // body
                    ctx.fillStyle = '#2b2b2b';
                    ctx.fillRect(-18, -6, 44, 12);
                    // barrel
                    ctx.fillStyle = '#111';
                    ctx.fillRect(26, -4, 18, 8);
                    // nozzle
                    ctx.fillStyle = '#666';
                    ctx.fillRect(42, -2, 8, 4);
                    // top pipe
                    ctx.fillStyle = '#444';
                    ctx.fillRect(-4, -10, 24, 4);
                    // grip
                    ctx.fillStyle = '#1a1a1a';
                    ctx.beginPath();
                    ctx.moveTo(6, 6);
                    ctx.lineTo(10, 22);
                    ctx.lineTo(0, 22);
                    ctx.lineTo(-4, 6);
                    ctx.closePath();
                    ctx.fill();
                    // ignition glow
                    ctx.save();
                    ctx.globalAlpha = 0.55;
                    ctx.shadowBlur = 14;
                    ctx.shadowColor = '#ff7a00';
                    ctx.fillStyle = '#ff7a00';
                    ctx.beginPath();
                    ctx.arc(46, 0, 3.5, 0, Math.PI * 2);
                    ctx.fill();
                    ctx.restore();
                },

            };

            // Disable shadow for crisp HUD/pickups; keep subtle world shading
            ctx.shadowBlur = 0;
            if (shapes[type]) shapes[type]();
            ctx.restore();
        }

        function draw() {
            // Level-themed backdrop (screen-space)
            const bgA = hardMode ? '#1a0a0a' : (levelTheme?.floorA || '#1a1a1a');
            ctx.fillStyle = bgA;
            ctx.fillRect(0, 0, canvas.width, canvas.height);

            if (gameState !== 'playing' && gameState !== 'paused') return;

            ctx.save();
            ctx.translate(-camera.x + camera.shakeX, -camera.y + camera.shakeY);

            // Subtle level tint layer
            if (levelTheme?.ambient) {
                const amb = levelTheme.ambient;
                ctx.save();
                ctx.globalAlpha = 0.08;
                const g = ctx.createRadialGradient(player.x, player.y, 0, player.x, player.y, 900);
                g.addColorStop(0, amb.colorA);
                g.addColorStop(1, 'rgba(0,0,0,0)');
                ctx.fillStyle = g;
                ctx.fillRect(camera.x, camera.y, canvas.width, canvas.height);
                ctx.restore();
            }

            // Grid (world-space)
            {
                ctx.strokeStyle = hardMode ? '#3a1a1a' : (levelTheme?.grid || '#2a2a2a');
                ctx.lineWidth = 1;
                // Slightly coarser grid on heavy levels for performance
                const gridSize = (currentLevel === 2 || currentLevel === 4 || currentLevel === 5) ? 60 : 50;
                const startX = Math.floor(camera.x / gridSize) * gridSize;
                const startY = Math.floor(camera.y / gridSize) * gridSize;
                for (let i = startX; i < camera.x + canvas.width; i += gridSize) { ctx.beginPath(); ctx.moveTo(i, camera.y); ctx.lineTo(i, camera.y + canvas.height); ctx.stroke(); }
                for (let i = startY; i < camera.y + canvas.height; i += gridSize) { ctx.beginPath(); ctx.moveTo(camera.x, i); ctx.lineTo(camera.x + canvas.width, i); ctx.stroke(); }
            }

            walls.forEach(w => {

                const wallFillByLevel = {
                    1: '#3b3b3b', // warehouse concrete
                    2: '#2b2f3f', // office walls
                    3: '#2f3a35', // factory metal
                    4: '#25332e', // HQ concrete
                    5: '#26262e'
                };
                ctx.fillStyle = hardMode ? '#553333' : (wallFillByLevel[currentLevel] || '#444');
                ctx.fillRect(w.x, w.y, w.width, w.height);
                ctx.strokeStyle = hardMode ? '#774444' : '#666';
                ctx.lineWidth = 2;
                ctx.strokeRect(w.x, w.y, w.width, w.height);

                if (currentLevel === 3 && w.width > 120 && w.height < 80) {
                    ctx.save();
                    ctx.globalAlpha = 0.35;
                    ctx.translate(w.x, w.y);
                    ctx.fillStyle = '#f6c945';
                    for (let i = 0; i < w.width; i += 16) {
                        ctx.save();
                        ctx.translate(i, 0);
                        ctx.rotate(-Math.PI / 4);
                        ctx.fillRect(-10, 8, 8, w.height * 1.2);
                        ctx.restore();
                    }
                    ctx.globalAlpha = 0.55;
                    ctx.fillStyle = '#111';
                    for (let i = 8; i < w.width; i += 16) {
                        ctx.save();
                        ctx.translate(i, 0);
                        ctx.rotate(-Math.PI / 4);
                        ctx.fillRect(-10, 8, 8, w.height * 1.2);
                        ctx.restore();
                    }
                    ctx.restore();
                }

                if (currentLevel === 4 && w.width > 140 && w.height > 26) {
                    // HQ: subtle tactical markings (no heavy glow)
                    ctx.save();
                    ctx.globalAlpha = 0.18;
                    ctx.strokeStyle = 'rgba(170, 255, 210, 0.55)';
                    ctx.lineWidth = 2;
                    // corner ticks
                    ctx.beginPath();
                    ctx.moveTo(w.x + 10, w.y + 10);
                    ctx.lineTo(w.x + 36, w.y + 10);
                    ctx.moveTo(w.x + 10, w.y + 10);
                    ctx.lineTo(w.x + 10, w.y + 36);

                    ctx.moveTo(w.x + w.width - 10, w.y + 10);
                    ctx.lineTo(w.x + w.width - 36, w.y + 10);
                    ctx.moveTo(w.x + w.width - 10, w.y + 10);
                    ctx.lineTo(w.x + w.width - 10, w.y + 36);

                    ctx.moveTo(w.x + 10, w.y + w.height - 10);
                    ctx.lineTo(w.x + 36, w.y + w.height - 10);
                    ctx.moveTo(w.x + 10, w.y + w.height - 10);
                    ctx.lineTo(w.x + 10, w.y + w.height - 36);

                    ctx.moveTo(w.x + w.width - 10, w.y + w.height - 10);
                    ctx.lineTo(w.x + w.width - 36, w.y + w.height - 10);
                    ctx.moveTo(w.x + w.width - 10, w.y + w.height - 10);
                    ctx.lineTo(w.x + w.width - 10, w.y + w.height - 36);
                    ctx.stroke();
                    ctx.restore();
                }
            });

            obstacles.forEach(o => {
                ctx.fillStyle = o.color;
                ctx.fillRect(o.x, o.y, o.width, o.height);
                ctx.strokeStyle = '#000';
                ctx.lineWidth = 2;
                ctx.strokeRect(o.x, o.y, o.width, o.height);

                if (o.type === 'box') {
                    ctx.strokeStyle = '#555';
                    ctx.lineWidth = 1;
                    ctx.beginPath();
                    ctx.moveTo(o.x, o.y);
                    ctx.lineTo(o.x + o.width, o.y + o.height);
                    ctx.moveTo(o.x + o.width, o.y);
                    ctx.lineTo(o.x, o.y + o.height);
                    ctx.stroke();
                } else if (o.type === 'barrel') {
                    ctx.fillStyle = 'rgba(255,255,255,0.12)';
                    ctx.fillRect(o.x + 5, o.y + o.height * 0.3, o.width - 10, 3);
                    ctx.fillRect(o.x + 5, o.y + o.height * 0.7, o.width - 10, 3);
                } else if (o.type === 'table' && currentLevel === 2) {
                    // office vibe: simple outline (optimized)
                    ctx.save();
                    ctx.globalAlpha = 0.20;
                    ctx.strokeStyle = '#7cf7ff';
                    ctx.lineWidth = 1;
                    ctx.strokeRect(o.x + 2, o.y + 2, o.width - 4, o.height - 4);
                    ctx.restore();
                }

            });

            // Ambient particles and graffiti (in-world)
            drawAmbient();
            drawGraffiti();

            // Flamethrower effects (only flame visuals; no range hint cone)
            drawFlame();

            // Pyro ability visual: animated fire ring around the player
            if (selectedCharacter === 'pyro' && pyroAura.active) {
                const t = performance.now() * 0.001;
                const r = pyroAura.radius;

                // soft outer glow ring
                ctx.save();
                ctx.globalCompositeOperation = 'lighter';
                const g = ctx.createRadialGradient(player.x, player.y, r * 0.45, player.x, player.y, r * 1.15);
                g.addColorStop(0, 'rgba(255, 140, 0, 0)');
                g.addColorStop(0.55, 'rgba(255, 140, 0, 0.08)');
                g.addColorStop(0.80, 'rgba(255, 70, 0, 0.14)');
                g.addColorStop(1, 'rgba(255, 0, 0, 0)');
                ctx.fillStyle = g;
                ctx.beginPath();
                ctx.arc(player.x, player.y, r * 1.12, 0, Math.PI * 2);
                ctx.fill();

                // main ring stroke
                const pulse = 1.0 + 0.03 * Math.sin(t * 6);
                ctx.globalAlpha = 0.75;
                ctx.lineWidth = 10;
                ctx.strokeStyle = 'rgba(255, 110, 0, 0.65)';
                ctx.beginPath();
                ctx.arc(player.x, player.y, r * pulse, 0, Math.PI * 2);
                ctx.stroke();

                // tongues of flame (arclets)
                ctx.globalAlpha = 0.85;
                const tongues = 26;
                for (let i = 0; i < tongues; i++) {
                    const a = (Math.PI * 2) * (i / tongues) + t * 0.8;
                    const wob = 10 * (0.5 + 0.5 * Math.sin(t * 3.5 + i));
                    const rr = r + wob;
                    const x = player.x + Math.cos(a) * rr;
                    const y = player.y + Math.sin(a) * rr;

                    const tg = ctx.createRadialGradient(x, y, 0, x, y, 26);
                    tg.addColorStop(0, 'rgba(255, 255, 220, 0.24)');
                    tg.addColorStop(0.35, 'rgba(255, 180, 60, 0.22)');
                    tg.addColorStop(0.7, 'rgba(255, 70, 0, 0.14)');
                    tg.addColorStop(1, 'rgba(160, 0, 0, 0)');
                    ctx.fillStyle = tg;
                    ctx.beginPath();
                    ctx.arc(x, y, 22 + wob * 0.25, 0, Math.PI * 2);
                    ctx.fill();
                }

                ctx.restore();
            }

            // Level 4: HQ floor marking (subtle, military style)
            if (currentLevel === 4) {
                const cx = WORLD_WIDTH * 0.55;
                const cy = WORLD_HEIGHT * 0.55;
                ctx.save();
                ctx.globalAlpha = 0.10;
                ctx.strokeStyle = 'rgba(170, 255, 210, 0.65)';
                ctx.lineWidth = 3;
                // simple target/zone ring (no glow)
                ctx.beginPath();
                ctx.arc(cx, cy, 120, 0, Math.PI * 2);
                ctx.stroke();
                ctx.beginPath();
                ctx.arc(cx, cy, 60, 0, Math.PI * 2);
                ctx.stroke();
                // crosshair
                ctx.beginPath();
                ctx.moveTo(cx - 140, cy);
                ctx.lineTo(cx - 90, cy);
                ctx.moveTo(cx + 90, cy);
                ctx.lineTo(cx + 140, cy);
                ctx.moveTo(cx, cy - 140);
                ctx.lineTo(cx, cy - 90);
                ctx.moveTo(cx, cy + 90);
                ctx.lineTo(cx, cy + 140);
                ctx.stroke();

                ctx.restore();
            }

            if (currentLevel === 0) tutorialTargets.forEach(t => { ctx.fillStyle = t.color; ctx.beginPath(); ctx.arc(t.x, t.y, t.radius, 0, Math.PI * 2); ctx.fill(); ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke(); if (!t.hit) { ctx.fillStyle = '#fff'; ctx.font = 'bold 15px Courier New'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('🎯', t.x, t.y); } });

            // Flamethrower fuel pickups (+30)
            flameFuelPickups.forEach(f => {
                const pulse = Math.sin(Date.now() / 180) * 2.2;
                ctx.save();
                ctx.shadowBlur = 20;
                ctx.shadowColor = '#ff7a00';
                const g = ctx.createRadialGradient(f.x, f.y, 0, f.x, f.y, f.radius + 12);
                g.addColorStop(0, 'rgba(255, 255, 220, 0.25)');
                g.addColorStop(0.35, 'rgba(255, 170, 60, 0.45)');
                g.addColorStop(1, 'rgba(255, 80, 0, 0.08)');
                ctx.fillStyle = g;
                ctx.beginPath();
                ctx.arc(f.x, f.y, f.radius + pulse + 8, 0, Math.PI * 2);
                ctx.fill();

                ctx.shadowBlur = 0;
                ctx.fillStyle = 'rgba(20, 10, 10, 0.75)';
                ctx.beginPath();
                ctx.arc(f.x, f.y, f.radius + pulse, 0, Math.PI * 2);
                ctx.fill();

                ctx.strokeStyle = '#fff';
                ctx.lineWidth = 3;
                ctx.beginPath();
                ctx.arc(f.x, f.y, f.radius + pulse, 0, Math.PI * 2);
                ctx.stroke();

                ctx.fillStyle = '#fff';
                ctx.font = 'bold 18px Arial';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText('🔥', f.x, f.y - 2);

                ctx.fillStyle = 'rgba(255,255,255,0.95)';
                ctx.font = 'bold 12px Arial';
                ctx.fillText(`+30`, f.x, f.y + 18);
                ctx.restore();
            });

            weaponPickups.forEach(p => { const pulse = Math.sin(Date.now() / 200) * 3; ctx.shadowBlur = 20; ctx.shadowColor = p.weapon.color; ctx.fillStyle = p.weapon.color; ctx.beginPath(); ctx.arc(p.x, p.y, p.radius + pulse, 0, Math.PI * 2); ctx.fill(); ctx.shadowBlur = 0; ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(Math.PI / 4); drawWeapon(0, 0, p.weaponType, 0.8); ctx.restore(); ctx.strokeStyle = '#fff'; ctx.lineWidth = 3; ctx.stroke(); ctx.fillStyle = '#fff'; ctx.font = 'bold 14px Arial'; ctx.textAlign = 'center'; ctx.fillText(p.weapon.name, p.x, p.y - 35); });

            enemies.forEach(e => {

                ctx.fillStyle = e.hitFlash > 0 ? '#ffffff' : e.color;
                ctx.beginPath();
                ctx.arc(e.x, e.y, e.radius, 0, Math.PI * 2);
                ctx.fill();
                ctx.strokeStyle = '#fff';
                ctx.lineWidth = 2;
                ctx.stroke();

                ctx.globalAlpha = 1;
                const barWidth = 40, barHeight = 6, hpPercent = e.hp / e.maxHP;
                ctx.fillStyle = '#000';
                ctx.fillRect(e.x - barWidth/2, e.y - e.radius - 15, barWidth, barHeight);
                ctx.fillStyle = hpPercent > 0.6 ? '#0f0' : hpPercent > 0.3 ? '#ff0' : '#f00';
                ctx.fillRect(e.x - barWidth/2, e.y - e.radius - 15, barWidth * hpPercent, barHeight);

                ctx.fillStyle = '#fff';
                ctx.font = '10px Arial';
                ctx.textAlign = 'center';
                ctx.fillText({ melee: '⚔️', ranged: '🔫', sniper: '🎯', tank: '🛡️', ambush: '👁️',  }[e.type] || '', e.x, e.y - e.radius - 20);
            });

            if (miniBoss) { ctx.save(); ctx.translate(miniBoss.x, miniBoss.y); ctx.rotate(miniBoss.rotation); ctx.fillStyle = miniBoss.color; ctx.beginPath(); ctx.arc(0, 0, miniBoss.radius, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = '#8B4513'; ctx.beginPath(); ctx.ellipse(0, -miniBoss.radius - 5, miniBoss.radius * 1.3, 8, 0, 0, Math.PI * 2); ctx.fill(); ctx.fillRect(-miniBoss.radius * 0.6, -miniBoss.radius - 25, miniBoss.radius * 1.2, 20); ctx.restore(); ctx.strokeStyle = '#fff'; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(miniBoss.x, miniBoss.y, miniBoss.radius, 0, Math.PI * 2); ctx.stroke(); }

            if (boss) { ctx.save(); ctx.translate(boss.x, boss.y); ctx.rotate(boss.rotation); ctx.fillStyle = ['#ff6600', '#ff3300', '#ff0000', '#cc0000'][boss.phase - 1]; ctx.beginPath(); ctx.arc(0, 0, boss.radius, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = '#000'; ctx.beginPath(); ctx.moveTo(-boss.radius, -10); ctx.lineTo(-boss.radius - 15, -25); ctx.lineTo(-boss.radius - 5, -15); ctx.closePath(); ctx.fill(); ctx.beginPath(); ctx.moveTo(boss.radius, -10); ctx.lineTo(boss.radius + 15, -25); ctx.lineTo(boss.radius + 5, -15); ctx.closePath(); ctx.fill(); ctx.fillStyle = boss.phase >= 3 ? '#ffff00' : '#ff0000'; ctx.beginPath(); ctx.arc(-15, 0, 8, 0, Math.PI * 2); ctx.arc(15, 0, 8, 0, Math.PI * 2); ctx.fill(); ctx.restore(); ctx.strokeStyle = '#fff'; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(boss.x, boss.y, boss.radius, 0, Math.PI * 2); ctx.stroke(); }

            ctx.save(); ctx.translate(player.x, player.y); const angle = Math.atan2(mouse.worldY - player.y, mouse.worldX - player.x); ctx.rotate(angle); drawWeapon(player.radius + 5, 0, player.weapon, 1); ctx.restore();

            // Player body
            ctx.fillStyle = player.color;
            ctx.beginPath();
            ctx.arc(player.x, player.y, player.radius, 0, Math.PI * 2);
            ctx.fill();

            // Special look: Pyro (orange-red circle + 2 red tanks behind)
            if (selectedCharacter === 'pyro') {
                const a = Math.atan2(mouse.worldY - player.y, mouse.worldX - player.x);
                const back = a + Math.PI;
                ctx.save();
                ctx.translate(player.x, player.y);

                // body gradient
                const grad = ctx.createRadialGradient(0, -4, 2, 0, 0, player.radius + 10);
                grad.addColorStop(0, 'rgba(255, 240, 170, 0.35)');
                grad.addColorStop(0.25, 'rgba(255, 140, 0, 0.55)');
                grad.addColorStop(1, 'rgba(170, 10, 0, 0.25)');
                ctx.globalCompositeOperation = 'lighter';
                ctx.fillStyle = grad;
                ctx.beginPath();
                ctx.arc(0, 0, player.radius + 2, 0, Math.PI * 2);
                ctx.fill();
                ctx.globalCompositeOperation = 'source-over';

                // two tanks behind
                const tankOffset = 10;
                const tankDist = player.radius + 10;
                const bx = Math.cos(back) * tankDist;
                const by = Math.sin(back) * tankDist;

                for (const s of [-1, 1]) {
                    const ox = bx + Math.cos(back + Math.PI / 2) * (tankOffset * s);
                    const oy = by + Math.sin(back + Math.PI / 2) * (tankOffset * s);

                    // cylinder
                    ctx.save();
                    ctx.translate(ox, oy);
                    ctx.rotate(a);
                    ctx.fillStyle = '#b10000';
                    ctx.strokeStyle = '#4a0000';
                    ctx.lineWidth = 2;
                    ctx.beginPath();
                    ctx.roundRect(-6, -14, 12, 28, 6);
                    ctx.fill();
                    ctx.stroke();

                    // highlight
                    ctx.globalAlpha = 0.25;
                    ctx.fillStyle = '#ff4040';
                    ctx.fillRect(-4, -12, 2, 24);
                    ctx.globalAlpha = 1;

                    // valve cap
                    ctx.fillStyle = '#222';
                    ctx.beginPath();
                    ctx.arc(0, -16, 4, 0, Math.PI * 2);
                    ctx.fill();

                    ctx.restore();
                }

                ctx.restore();
            }

            if (player.hasTopLine) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(player.x - player.radius + 5, player.y - player.radius + 5); ctx.lineTo(player.x + player.radius - 5, player.y - player.radius + 5); ctx.stroke(); }
            if (player.color === '#ff8800') { ctx.strokeStyle = '#000'; ctx.lineWidth = 4; ctx.beginPath(); ctx.arc(player.x, player.y, player.radius, 0, Math.PI * 2); ctx.stroke(); }
            if (player.color === '#40E0D0') { ctx.save(); ctx.translate(player.x, player.y); ctx.rotate(-Math.PI / 4); ctx.fillStyle = '#8B4513'; ctx.fillRect(-player.radius - 10, -5, player.radius * 2 + 20, 10); for (let i = -player.radius; i <= player.radius; i += 15) { ctx.fillStyle = '#FFD700'; ctx.fillRect(i, -8, 6, 8); ctx.fillStyle = '#ff0000'; ctx.beginPath(); ctx.moveTo(i + 3, -13); ctx.lineTo(i, -8); ctx.lineTo(i + 6, -8); ctx.closePath(); ctx.fill(); ctx.fillStyle = '#ffcccc'; ctx.beginPath(); ctx.moveTo(i + 3, -13); ctx.lineTo(i + 1, -11); ctx.lineTo(i + 3, -8); ctx.closePath(); ctx.fill(); } ctx.restore(); }
            if (player.color === '#9933FF') { ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(player.x, player.y - 5, 8, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = '#000'; ctx.beginPath(); ctx.arc(player.x - 4, player.y - 7, 1.5, 0, Math.PI * 2); ctx.arc(player.x + 4, player.y - 7, 1.5, 0, Math.PI * 2); ctx.fill(); ctx.beginPath(); ctx.moveTo(player.x, player.y - 3); ctx.lineTo(player.x - 2, player.y + 1); ctx.lineTo(player.x + 2, player.y + 1); ctx.closePath(); ctx.fill(); ctx.beginPath(); ctx.moveTo(player.x - 5, player.y + 5); ctx.lineTo(player.x + 5, player.y + 5); ctx.arc(player.x, player.y + 5, 5, 0, Math.PI, true); ctx.closePath(); ctx.fill(); }

            ctx.strokeStyle = '#fff'; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(player.x, player.y, player.radius, 0, Math.PI * 2); ctx.stroke();

            if (abilityActive && selectedCharacter === 'tank') { ctx.save(); ctx.globalAlpha = 0.3; ctx.fillStyle = '#00ffff'; ctx.beginPath(); ctx.arc(player.x, player.y, player.radius + 15, 0, Math.PI * 2); ctx.fill(); ctx.globalAlpha = 0.6; ctx.strokeStyle = '#00ffff'; ctx.lineWidth = 4; ctx.shadowBlur = 20; ctx.shadowColor = '#00ffff'; ctx.stroke(); ctx.restore(); }
            if (abilityActive && selectedCharacter === 'machete_char') { ctx.save(); ctx.globalAlpha = 0.4; ctx.strokeStyle = '#ff0000'; ctx.lineWidth = 6; ctx.shadowBlur = 25; ctx.shadowColor = '#ff0000'; ctx.beginPath(); ctx.arc(player.x, player.y, player.radius + 20, 0, Math.PI * 2); ctx.stroke(); ctx.restore(); }
            if (macheteSlash) { ctx.save(); ctx.translate(macheteSlash.x, macheteSlash.y); ctx.rotate(macheteSlash.angle); const alpha = macheteSlash.duration / 10; ctx.strokeStyle = abilityActive && selectedCharacter === 'machete_char' ? `rgba(255, 0, 0, ${alpha})` : `rgba(153, 51, 255, ${alpha})`; ctx.lineWidth = abilityActive && selectedCharacter === 'machete_char' ? 8 : 5; ctx.beginPath(); ctx.arc(0, 0, macheteSlash.radius, -Math.PI / 4, Math.PI / 4); ctx.stroke(); ctx.restore(); }

            combatEffects.draw(ctx, reducedMotion.matches);

            // Player bullets
            bullets.forEach(b => {
                {
                    ctx.fillStyle = b.color;
                    ctx.shadowBlur = 15;
                    ctx.shadowColor = b.color;
                    ctx.beginPath();
                    ctx.arc(b.x, b.y, b.radius, 0, Math.PI * 2);
                    ctx.fill();
                    ctx.shadowBlur = 0;
                }
            });

            // Short barrel flashes for all ballistic weapons
            if (muzzleFlashes.length) {
                ctx.save();
                ctx.globalCompositeOperation = 'lighter';
                for (const f of muzzleFlashes) {
                    const a = Math.max(0, f.life / f.maxLife);
                    const g = ctx.createRadialGradient(f.x, f.y, 0, f.x, f.y, 22);
                    g.addColorStop(0, `rgba(255, 245, 210, ${0.35 * a})`);
                    g.addColorStop(0.35, `rgba(255, 210, 90, ${0.28 * a})`);
                    g.addColorStop(1, 'rgba(255, 120, 0, 0)');
                    ctx.fillStyle = g;
                    ctx.beginPath();
                    ctx.arc(f.x, f.y, 22, 0, Math.PI * 2);
                    ctx.fill();
                }
                ctx.restore();
            }

            enemyBullets.forEach(b => { if (b.mine) { ctx.fillStyle = b.timer < 30 ? '#ff0000' : '#ff00ff'; ctx.beginPath(); ctx.arc(b.x, b.y, b.radius, 0, Math.PI * 2); ctx.fill(); ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke(); ctx.fillStyle = '#fff'; ctx.font = 'bold 10px Arial'; ctx.textAlign = 'center'; ctx.fillText(Math.ceil(b.timer / 30), b.x, b.y + 3); } else { ctx.fillStyle = b.color; ctx.shadowBlur = b.homing ? 20 : 10; ctx.shadowColor = b.color; ctx.beginPath(); ctx.arc(b.x, b.y, b.radius, 0, Math.PI * 2); ctx.fill(); ctx.shadowBlur = 0; } });

            ctx.restore();

            if (boss) {
                const bX = boss.x - camera.x, bY = boss.y - camera.y;
                if (bX < -boss.radius || bX > canvas.width + boss.radius || bY < -boss.radius || bY > canvas.height + boss.radius) {
                    const cX = canvas.width / 2, cY = canvas.height / 2, a = Math.atan2(bY - cY, bX - cX), dx = Math.cos(a), dy = Math.sin(a);
                    const margin = 100, dists = [dx > 0 ? (canvas.width - margin - cX) / dx : Infinity, dx < 0 ? (margin - cX) / dx : Infinity, dy > 0 ? (canvas.height - margin - cY) / dy : Infinity, dy < 0 ? (margin - cY) / dy : Infinity];
                    const minD = Math.min(...dists), iX = cX + dx * minD, iY = cY + dy * minD;
                    ctx.save(); ctx.translate(iX, iY); ctx.rotate(a); ctx.fillStyle = '#ff0000'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 3; ctx.shadowBlur = 15; ctx.shadowColor = '#ff0000'; ctx.beginPath(); ctx.moveTo(20, 0); ctx.lineTo(-10, -15); ctx.lineTo(-5, 0); ctx.lineTo(-10, 15); ctx.closePath(); ctx.fill(); ctx.stroke(); ctx.shadowBlur = 0; ctx.fillStyle = '#fff'; ctx.font = 'bold 16px Arial'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('💀', -5, 0); ctx.restore();
                }
            }

            if (player.hp < player.maxHP * 0.5) {
                const vignette = ctx.createRadialGradient(canvas.width / 2, canvas.height / 2, 0, canvas.width / 2, canvas.height / 2, canvas.width * 0.7);
                vignette.addColorStop(0, 'rgba(0, 0, 0, 0)');
                vignette.addColorStop(1, `rgba(255, 0, 0, ${0.3 * (1 - player.hp / (player.maxHP * 0.5))})`);
                ctx.fillStyle = vignette;
                ctx.fillRect(0, 0, canvas.width, canvas.height);
            }

            ctx.strokeStyle = '#00ff00'; ctx.lineWidth = 2; ctx.shadowBlur = 5; ctx.shadowColor = '#00ff00'; ctx.beginPath(); ctx.arc(mouse.x, mouse.y, 20, 0, Math.PI * 2); ctx.stroke(); ctx.beginPath(); ctx.moveTo(mouse.x - 25, mouse.y); ctx.lineTo(mouse.x - 8, mouse.y); ctx.moveTo(mouse.x + 25, mouse.y); ctx.lineTo(mouse.x + 8, mouse.y); ctx.moveTo(mouse.x, mouse.y - 25); ctx.lineTo(mouse.x, mouse.y - 8); ctx.moveTo(mouse.x, mouse.y + 25); ctx.lineTo(mouse.x, mouse.y + 8); ctx.stroke(); ctx.shadowBlur = 0;
        }

        function updateHUD() {
            const hp = Math.max(0, Math.floor(player.hp));
            const maxHP = player.maxHP;

            const hpEl = document.getElementById('playerHP');
            const maxHpEl = document.getElementById('playerMaxHP');
            const ammoEl = document.getElementById('ammo');
            const weaponNameEl = document.getElementById('weaponName');

            if (hpEl) hpEl.textContent = hp;
            if (maxHpEl) maxHpEl.textContent = maxHP;
            if (weaponNameEl) weaponNameEl.textContent = currentWeapon.name;
            if (ammoEl) ammoEl.textContent = currentWeapon.ammo === Infinity ? '∞' : currentWeapon.ammo;

            // HUD animations
            if (prevHudHP !== null && hp !== prevHudHP) {
                hudPulse(hudHP, 'pop');
                if (hp < prevHudHP) hudPulse(hudHP, 'hit');
            }

            const ammoVal = currentWeapon.ammo === Infinity ? Infinity : currentWeapon.ammo;
            if (prevHudAmmo !== null && ammoVal !== prevHudAmmo) {
                hudPulse(hudAmmo, 'pop');
            }

            if (hudHP) {
                const danger = (hp / maxHP) <= 0.35;
                hudHP.classList.toggle('danger', danger);
            }

            prevHudHP = hp;
            prevHudAmmo = ammoVal;
        }

        function gameOver() {
            resetInput();
            gameState = 'gameover';
            stopMusic();
            stopAllHtmlMusic(true);
            document.getElementById('miniBossHealth').style.display = 'none';
            document.getElementById('deathKills').textContent = kills;
            document.getElementById('deathTotal').textContent = totalEnemies;
            document.getElementById('deathMenu').style.display = 'block';
        }
        function levelComplete() {
            gameState = 'complete';
            stopMusic();
            stopAllHtmlMusic(true);

            if (hardMode) {
                // If we're on the boss (level 5) OR progress already reached 5, finish hard-mode.
                if (currentLevel === 5 || hardModeProgress >= 5) {
                    afterSession(() => {
                        showGameAlert('🎉 HARD-MODE ПРОЙДЕН!\n\nВы победили!\n\nВсе уровни пройдены!', 'Победа').then(() => {
                            hardMode = false;
                            backToMainMenuFromGame();
                        });
                    }, 100);
                    return;
                }

                // Otherwise move to next level (1→2→3→4→5)
                hardModeProgress++;
                afterSession(() => {
                    document.getElementById('gameContainer').style.display = 'none';
                    document.getElementById('characterSelect').style.display = 'block';
                    selectedLevel = hardModeProgress;
                }, 500);
                return;
            }

            afterSession(() => {
                showGameAlert('🎉 УРОВЕНЬ ПРОЙДЕН!\n\nОтличная работа!', 'Уровень пройден').then(() => backToMainMenuFromGame());
            }, 100);
        }
        function backToMainMenuFromGame() {
            sessionToken++; combatTimers = [];
            resetInput(); combatEffects.reset(); muzzleFlashes = [];
            hardMode = false;
            gameState = 'menu';
            stopMusic();
            stopAllHtmlMusic(true);
            document.getElementById('gameContainer').style.display = 'none';
            document.getElementById('mainMenu').style.display = 'flex';
            document.getElementById('bossHealth').style.display = 'none';
            document.getElementById('miniBossHealth').style.display = 'none';
            tutorialTextElement.style.display = 'none';

            // Safety: ensure pyro aura is off when returning to menu
            pyroAura.active = false;
            pyroAura.t = 0;
            pyroAura.tickAcc = 0;
            if (selectedCharacter === 'ammo') for (const type in weapons) if (weapons[type].originalAmmo !== undefined) { weapons[type].ammo = weapons[type].originalAmmo; delete weapons[type].originalAmmo; }
            try {
                if (musicEnabled) safePlay(menuMusic);
            } catch (e) {}
        }

        let lastTime = 0;
        const targetFPS = 60;
        const frameDelay = 1000 / targetFPS;

        function gameLoop(currentTime = 0) {
            const deltaTime = currentTime - lastTime;

            if (deltaTime >= frameDelay) {
                lastTime = currentTime - (deltaTime % frameDelay);
                update();
                draw();
            }

            requestAnimationFrame(gameLoop);
        }
        gameLoop();
