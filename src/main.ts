import { Game } from './core/Game';
import { AircraftType, Difficulty, GameConfig, GameMode } from './entities/types';
import { loadPolicyFromFiles } from './systems/policy/loaders';
import type { PolicyDecisionProvider, PolicySourceKind } from './systems/policy/types';

const canvas = document.getElementById('gameCanvas') as HTMLCanvasElement;
const container = document.getElementById('gameContainer') as HTMLDivElement;

if (!canvas || !container) {
	throw new Error('Missing required game container elements.');
}

let activeGame: Game | null = null;
let activePanel: HTMLDivElement | null = null;
let monitorToken = 0;

function clearPanel() {
	if (!activePanel) return;
	activePanel.remove();
	activePanel = null;
}

function createSelect(options: Array<{ value: string; label: string }>, defaultValue: string): HTMLSelectElement {
	const select = document.createElement('select');
	select.style.width = '100%';
	select.style.padding = '8px';
	select.style.borderRadius = '6px';
	select.style.border = '1px solid #0f3460';
	select.style.background = '#10182e';
	select.style.color = '#ffffff';

	options.forEach((item) => {
		const option = document.createElement('option');
		option.value = item.value;
		option.textContent = item.label;
		select.appendChild(option);
	});

	select.value = defaultValue;
	return select;
}

function createField(labelText: string, input: HTMLElement): HTMLDivElement {
	const wrapper = document.createElement('div');
	wrapper.style.display = 'grid';
	wrapper.style.gap = '6px';

	const label = document.createElement('label');
	label.textContent = labelText;
	label.style.fontSize = '14px';
	label.style.color = '#d7e0ff';

	wrapper.appendChild(label);
	wrapper.appendChild(input);
	return wrapper;
}

function createButton(text: string, color: string): HTMLButtonElement {
	const button = document.createElement('button');
	button.textContent = text;
	button.style.padding = '10px 14px';
	button.style.border = 'none';
	button.style.borderRadius = '8px';
	button.style.background = color;
	button.style.color = '#fff';
	button.style.cursor = 'pointer';
	button.style.fontSize = '15px';
	return button;
}

function createPanel(): HTMLDivElement {
	const panel = document.createElement('div');
	panel.style.position = 'absolute';
	panel.style.top = '50%';
	panel.style.left = '50%';
	panel.style.transform = 'translate(-50%, -50%)';
	panel.style.minWidth = '320px';
	panel.style.padding = '20px';
	panel.style.borderRadius = '12px';
	panel.style.background = 'rgba(7, 12, 24, 0.92)';
	panel.style.border = '1px solid #29407a';
	panel.style.boxShadow = '0 20px 60px rgba(0, 0, 0, 0.45)';
	panel.style.display = 'grid';
	panel.style.gap = '12px';
	panel.style.zIndex = '10';
	return panel;
}

function startMatch(config: GameConfig) {
	clearPanel();

	if (activeGame) {
		activeGame.destroy();
		activeGame = null;
	}

	const game = new Game(canvas, config);
	activeGame = game;
	game.start();

	// expose for debugging in browser console
	// use `activeGame` in console to call things like `activeGame.triggerBoss('left')`
	// Note: this is for local debugging only.
	(window as any).activeGame = game;
	watchGameOver(game, config);
}

function mountResultMenu(winnerText: string, lastConfig: GameConfig) {
	clearPanel();

	const panel = createPanel();
	const title = document.createElement('h2');
	title.textContent = winnerText || '对局结束';
	title.style.fontSize = '28px';
	title.style.color = '#ffffff';

	const restartButton = createButton('再来一局', '#e94560');
	restartButton.addEventListener('click', () => {
		startMatch(lastConfig);
	});

	const backButton = createButton('返回开局', '#355cba');
	backButton.addEventListener('click', () => {
		if (activeGame) {
			activeGame.destroy();
			activeGame = null;
		}
		mountStartMenu(startMatch);
	});

	panel.appendChild(title);
	panel.appendChild(restartButton);
	panel.appendChild(backButton);
	container.appendChild(panel);
	activePanel = panel;
}

function watchGameOver(game: Game, config: GameConfig) {
	const token = ++monitorToken;

	const check = () => {
		if (token !== monitorToken || game !== activeGame) {
			return;
		}

		if (game.isGameOver()) {
			// 结束后立即销毁当前对局，避免后台 loop 继续跑到结果页之后
			game.destroy();
			if (activeGame === game) {
				activeGame = null;
			}
			mountResultMenu(game.getWinnerText(), config);
			return;
		}

		requestAnimationFrame(check);
	};

	requestAnimationFrame(check);
}

function mountStartMenu(onStart: (config: GameConfig) => void) {
	if (activeGame) {
		activeGame.destroy();
		activeGame = null;
	}
	monitorToken++;
	clearPanel();
	const panel = createPanel();
	let loadedPolicy: PolicyDecisionProvider | null = null;
	let loadedPolicyLabel = '未加载策略';
	let loadingPolicy = false;

	const title = document.createElement('h2');
	title.textContent = '开始对局';
	title.style.fontSize = '24px';
	title.style.color = '#ffffff';

	const modeSelect = createSelect(
		[
			{ value: 'single', label: '单人 vs AI' },
			{ value: 'dual', label: '双人对战' },
			{ value: 'selfplay', label: '自博弈（AI vs AI）' },
		],
		'single'
	);

	const difficultySelect = createSelect(
		[
			{ value: 'easy', label: '简单' },
			{ value: 'normal', label: '普通' },
			{ value: 'hard', label: '困难' },
		],
		'normal'
	);

	const aircraftOptions = [
		{ value: 'scatter', label: '散射型' },
		{ value: 'laser', label: '激光型' },
		{ value: 'tracking', label: '追踪型' },
	];

	const player1AircraftSelect = createSelect(aircraftOptions, 'scatter');
	const player2AircraftSelect = createSelect(aircraftOptions, 'scatter');
	const policySourceSelect = createSelect(
		[
			{ value: 'json', label: 'JSON policy（policy.json）' },
			{ value: 'onnx', label: 'ONNX native（model.onnx + policy.json/meta）' },
			{ value: 'tfjs', label: 'TFJS native（model.json + shards + policy.json/meta）' },
			{ value: 'auto', label: '自动检测' },
		],
		'json'
	);
	const policyInput = document.createElement('input');
	policyInput.type = 'file';
	policyInput.accept = '.json,.onnx,.bin,application/json';
	policyInput.multiple = true;
	policyInput.setAttribute('webkitdirectory', '');
	policyInput.setAttribute('directory', '');
	policyInput.style.width = '100%';
	policyInput.style.color = '#d7e0ff';

	const policyStatus = document.createElement('div');
	policyStatus.textContent = '未选择文件。JSON 直接加载 policy.json；ONNX/TFJS 请选择模型文件，并可同时选 policy.json 作为共享 manifest。';
	policyStatus.style.fontSize = '12px';
	policyStatus.style.color = '#9fb1e6';
	policyStatus.style.wordBreak = 'break-all';

	const startButton = createButton('开始游戏', '#e94560');

	const syncPolicyInputHints = () => {
		const sourceKind = policySourceSelect.value as PolicySourceKind;
		if (sourceKind === 'json') {
			policyInput.accept = '.json,application/json';
		} else if (sourceKind === 'onnx') {
			policyInput.accept = '.onnx,.json,application/json';
		} else if (sourceKind === 'tfjs') {
			policyInput.accept = '.json,.bin,application/json';
		} else {
			policyInput.accept = '.json,.onnx,.bin,application/json';
		}
	};

	const updateStartButtonState = () => {
		startButton.disabled = loadingPolicy;
		startButton.style.opacity = loadingPolicy ? '0.72' : '1';
	};

	const refreshPolicySelection = async () => {
		const files = Array.from(policyInput.files ?? []);
		if (files.length === 0) {
			loadedPolicy = null;
			loadedPolicyLabel = '未选择文件';
			policyStatus.textContent = '未选择文件。JSON 直接加载 policy.json；ONNX/TFJS 请选择模型文件，并可同时选 policy.json 作为共享 manifest。';
			updateStartButtonState();
			return;
		}

		loadingPolicy = true;
		policyStatus.textContent = '正在加载策略文件...';
		updateStartButtonState();

		try {
			const result = await loadPolicyFromFiles(files, policySourceSelect.value as PolicySourceKind);
			loadedPolicy = result.provider;
			loadedPolicyLabel = `${result.kind.toUpperCase()}: ${result.label}`;
			policyStatus.textContent = `已加载 ${loadedPolicyLabel}`;
		} catch (error) {
			loadedPolicy = null;
			loadedPolicyLabel = '加载失败';
			policyStatus.textContent = `加载失败：${error instanceof Error ? error.message : String(error)}`;
			console.error(error);
		}

		loadingPolicy = false;
		updateStartButtonState();
	};

	policySourceSelect.addEventListener('change', () => {
		syncPolicyInputHints();
		if ((policyInput.files?.length ?? 0) > 0) {
			void refreshPolicySelection();
		}
	});

	policyInput.addEventListener('change', () => {
		void refreshPolicySelection();
	});

	syncPolicyInputHints();
	updateStartButtonState();

	const difficultyField = createField('AI 难度', difficultySelect);

	modeSelect.addEventListener('change', () => {
		const mode = modeSelect.value as GameMode;
		const aiMode = mode === 'single' || mode === 'selfplay';
		difficultyField.style.opacity = aiMode ? '1' : '0.45';
		difficultySelect.disabled = !aiMode;
	});

	startButton.addEventListener('click', () => {
		const config: GameConfig = {
			mode: modeSelect.value as GameMode,
			difficulty: difficultySelect.value as Difficulty,
			player1Aircraft: player1AircraftSelect.value as AircraftType,
			player2Aircraft: player2AircraftSelect.value as AircraftType,
			agentPolicies: loadedPolicy
				? (modeSelect.value === 'single'
					? { right: loadedPolicy }
					: modeSelect.value === 'selfplay'
						? { left: loadedPolicy, right: loadedPolicy }
						: undefined)
				: undefined,
		};

		panel.remove();
		onStart(config);
	});

	panel.appendChild(title);
	panel.appendChild(createField('模式', modeSelect));
	panel.appendChild(difficultyField);
	panel.appendChild(createField('左侧机体', player1AircraftSelect));
	panel.appendChild(createField('右侧机体', player2AircraftSelect));
	panel.appendChild(createField('策略类型', policySourceSelect));
	panel.appendChild(createField('AI 策略文件', policyInput));
	panel.appendChild(policyStatus);
	panel.appendChild(startButton);

	container.appendChild(panel);
	activePanel = panel;
	modeSelect.dispatchEvent(new Event('change'));
}

mountStartMenu(startMatch);

const hot = (import.meta as ImportMeta & { hot?: { dispose(cb: () => void): void } }).hot;

if (hot) {
	hot.dispose(() => {
		monitorToken++;
		if (activeGame) {
			activeGame.destroy();
			activeGame = null;
		}
	});
}
