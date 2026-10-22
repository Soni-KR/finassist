const $ = (id) => document.getElementById(id);
let selectedAgent = 'auto';
let lastResult = null;
let busy = false;
let aiConnection = null;
let connectionLoaded = false;
let connecting = false;
const suggestions = {
  auto: ['What can the agents do?', 'Summarize financial performance', 'Review transactions for unusual activity'],
  general: ['What can the agents do?', 'Explain profit margin', 'How does auto-routing work?'],
  finance: ['Summarize financial performance', 'Calculate profit and margin', 'Compare revenue with the previous period'],
  review: ['Review the transactions', 'Check for duplicate IDs', 'Find transactions above the threshold'],
};
const descriptions = {
  auto: 'Ask naturally. A simple router connects your question to the right agent.',
  general: 'Explore the platform and learn a few basic finance concepts.',
  finance: 'Calculate profit, margin, and growth from your workspace figures.',
  review: 'Check your CSV for duplicate IDs and amounts of $10,000 or more.',
};
const names = {auto: 'Agent assistant', general: 'General assistant', finance: 'Financial analyst', review: 'Transaction reviewer'};
const welcomeTemplate = $('chat').innerHTML;

function setStatus(text, error = false) {
  $('status').textContent = text;
  $('status').classList.toggle('error', error);
}

function showSuggestions() {
  const container = $('examples');
  if (!container) return;
  container.replaceChildren();
  $('agent-description').textContent = descriptions[selectedAgent];
  for (const text of suggestions[selectedAgent]) {
    const button = document.createElement('button');
    button.className = 'example';
    button.append(document.createTextNode(text));
    const arrow = document.createElement('span');
    arrow.textContent = '↗';
    button.append(arrow);
    button.addEventListener('click', () => {
      if (busy) return;
      $('question').value = text;
      $('chat-form').requestSubmit();
    });
    container.append(button);
  }
}

function figures() {
  return Object.fromEntries(['revenue', 'expenses', 'previous_revenue'].map(id => [id, $(id).value]));
}

function updateSummary() {
  const valid = ['revenue', 'expenses', 'previous_revenue'].every(id => $(id).value !== '' && $(id).checkValidity());
  if (!valid) {
    for (const key of ['revenue', 'expenses', 'profit']) $(`metric-${key}`).textContent = '—';
    $('metric-margin').textContent = 'Enter valid figures';
    return;
  }
  const values = figures();
  // Round to cents, matching the Python tool's monetary inputs.
  const revenue = Math.round(Number(values.revenue) * 100);
  const expenses = Math.round(Number(values.expenses) * 100);
  const format = value => (value / 100).toLocaleString('en-US', {style: 'currency', currency: 'USD', maximumFractionDigits: 2});
  $('metric-revenue').textContent = format(revenue);
  $('metric-expenses').textContent = format(expenses);
  $('metric-profit').textContent = format(revenue - expenses);
  $('metric-margin').textContent = revenue ? `${((revenue - expenses) / revenue * 100).toFixed(1)}% profit margin` : 'Margin unavailable · zero revenue';
}

function addMessage(label, text, type, result) {
  if ($('examples')) $('chat').replaceChildren();
  const block = document.createElement('article');
  block.className = `message ${type}`;
  const heading = document.createElement('div');
  heading.className = 'message-label';
  heading.textContent = label;
  if (result) {
    const badge = document.createElement('span');
    badge.className = 'tag';
    badge.textContent = result.mode === 'ai' ? 'AI' : 'DEMO';
    heading.append(badge);
  }
  const body = document.createElement('div');
  body.className = 'message-body';
  body.textContent = text;
  block.append(heading, body);
  if (result) {
    const route = document.createElement('div');
    route.className = 'route';
    route.textContent = `${result.route} → ${result.agent_name} → ${result.mode === 'ai' ? result.model || 'AI response' : 'Demo result'}`;
    block.append(route);
  }
  $('chat').append(block);
  $('chat').scrollTop = $('chat').scrollHeight;
}

document.querySelectorAll('[data-agent]').forEach(button => {
  button.addEventListener('click', () => {
    if (busy) return;
    selectedAgent = button.dataset.agent;
    document.querySelectorAll('[data-agent]').forEach(other => {
      other.classList.toggle('active', other === button);
      other.setAttribute('aria-pressed', String(other === button));
    });
    $('chat-title').textContent = names[selectedAgent];
    showSuggestions();
  });
});

async function loadSample() {
  try {
    const response = await fetch('/api/sample');
    if (!response.ok) throw new Error('Could not load sample data. Refresh to retry.');
    const data = await response.json();
    for (const [key, value] of Object.entries(data.figures)) $(key).value = value;
    $('csv').value = data.csv;
    $('csv-file').value = '';
    $('filename').textContent = 'transactions.csv';
    $('file-caption').textContent = '6 sample transactions';
    updateSummary();
    await refreshConnection(!connectionLoaded);
    connectionLoaded = true;
  } catch (error) {
    setStatus(error.message, true);
  }
}

$('reset').addEventListener('click', loadSample);
$('clear').addEventListener('click', () => {
  if (busy) return;
  $('chat').innerHTML = welcomeTemplate;
  lastResult = null;
  $('export').disabled = true;
  showSuggestions();
});
for (const id of ['revenue', 'expenses', 'previous_revenue']) $(id).addEventListener('input', updateSummary);
$('csv').addEventListener('input', () => { $('filename').textContent = 'Edited CSV'; $('file-caption').textContent = 'Workspace changes'; });
$('csv-file').addEventListener('change', async event => {
  const file = event.target.files[0];
  if (!file) return;
  if (file.size > 50000) return setStatus('Choose a CSV file smaller than 50 KB.', true);
  try {
    $('csv').value = await file.text();
    $('filename').textContent = file.name;
    $('file-caption').textContent = 'Loaded locally · ready to review';
    setStatus('CSV loaded. Select Transaction reviewer or ask to review transactions.');
  } catch { setStatus('Could not read this file. Try another CSV.', true); }
});
$('mode').addEventListener('change', () => setStatus(modeDescription()));

$('chat-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (busy) return;
  const message = $('question').value.trim();
  if (!message) return;
  busy = true;
  const mode = $('mode').value;
  const disabledControls = [...document.querySelectorAll('button,input,textarea,select')];
  disabledControls.forEach(control => { control.disabled = true; });
  addMessage('You', message, 'user');
  setStatus(mode === 'ai' ? 'Waiting for the AI response…' : 'Routing your question…');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 130000);
  let succeeded = false;
  try {
    const response = await fetch('/api/chat', {
      method: 'POST', headers: {'Content-Type': 'application/json'}, signal: controller.signal,
      body: JSON.stringify({message, agent: selectedAgent, mode, figures: figures(), csv: $('csv').value}),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Request failed. Please try again.');
    addMessage(data.agent_name, data.answer, 'assistant', data);
    lastResult = data;
    $('question').value = '';
    succeeded = true;
    setStatus(`${data.agent_name} finished · ${mode === 'ai' ? 'AI response' : 'Demo result'}`);
  } catch (error) {
    setStatus(error.name === 'AbortError' ? 'Request timed out. Try again or switch to Demo.' : error.message, true);
  } finally {
    clearTimeout(timer);
    busy = false;
    disabledControls.forEach(control => { control.disabled = false; });
    $('export').disabled = !lastResult;
    if (succeeded) $('question').focus();
  }
});

$('question').addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    $('chat-form').requestSubmit();
  }
});
$('export').addEventListener('click', () => {
  if (!lastResult) return;
  const report = `${lastResult.agent_name} (${lastResult.mode}${lastResult.model ? ', ' + lastResult.provider + ', ' + lastResult.model : ''})\n\n${lastResult.answer}\n\nTool results:\n${JSON.stringify(lastResult.evidence, null, 2)}`;
  const url = URL.createObjectURL(new Blob([report], {type: 'text/plain;charset=utf-8'}));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'finassist-answer.txt';
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

function updateConnection(data, activate = false) {
  aiConnection = data;
  const option = $('mode').querySelector('[value="ai"]');
  option.disabled = !data.configured;
  option.textContent = data.configured ? 'AI' : 'AI · setup needed';
  $('mode').title = data.configured ? `AI model: ${data.model}` : 'Click Connect AI to set up your API key.';
  $('ai-badge').textContent = data.configured ? `${data.provider === 'ollama' ? 'Local AI' : 'OpenAI'} · ${data.model}` : 'AI not connected';
  $('ai-badge').classList.toggle('connected', data.configured);
  $('connect-ai').textContent = data.configured ? 'AI settings' : 'Connect AI';
  $('ai-model').value = data.model;
  $('ai-provider').value = data.configured ? data.provider || 'openai' : data.local_models?.length ? 'ollama' : 'openai';
  $('local-models').replaceChildren();
  for (const name of data.local_models || []) {
    const option = document.createElement('option');
    option.value = name;
    $('local-models').append(option);
  }
  renderProvider();
  $('disconnect-ai').hidden = !data.configured;
  if (activate && data.configured) $('mode').value = 'ai';
  if (!data.configured) $('mode').value = 'demo';
  setStatus(modeDescription());
}

function modeDescription() {
  if ($('mode').value !== 'ai') return 'Demo mode · fixed replies and calculated results';
  return aiConnection?.provider === 'ollama' ? `Local AI · ${aiConnection.model} · runs on this computer, no API key` : `AI mode · ${aiConnection?.model} · questions and relevant results go to OpenAI`;
}

function renderProvider(changeModel = false) {
  const local = $('ai-provider').value === 'ollama';
  $('key-fields').hidden = local;
  $('api-key').required = !local;
  $('get-api-key').hidden = local;
  $('local-privacy').hidden = !local;
  $('provider-description').textContent = local ? 'Run the three agents with a downloaded Ollama model. Questions and results stay on this computer. No API key is needed.' : 'Connect the three agents to OpenAI. The connection test makes one small API request. API usage is billed to your OpenAI account.';
  $('model-hint').textContent = local ? 'Choose a model already downloaded in Ollama. Start the Ollama app before connecting.' : 'Use a Responses API model available to your OpenAI project.';
  if (changeModel) {
    $('api-key').value = '';
    $('ai-model').value = local ? aiConnection?.local_models?.[0] || 'qwen2.5:7b' : 'gpt-4.1-mini';
    connectionStatus(local ? 'No API key needed. Test the local model when ready.' : 'Enter your OpenAI API key to test the connection.');
  }
}
$('ai-provider').addEventListener('change', () => renderProvider(true));

async function refreshConnection(activate = false) {
  const response = await fetch('/api/ai');
  if (!response.ok) throw new Error('Could not read AI connection settings. Refresh to retry.');
  updateConnection(await response.json(), activate);
}

function connectionStatus(message, error = false) {
  $('connection-status').textContent = message;
  $('connection-status').classList.toggle('error', error);
}

$('connect-ai').addEventListener('click', async () => {
  if (busy) return;
  $('api-key').value = '';
  $('ai-dialog').showModal();
  try {
    await refreshConnection();
    connectionStatus(aiConnection.configured ? `Current model: ${aiConnection.model}. You can test or replace this connection.` : 'Choose a local model or configure OpenAI to connect.');
  } catch (error) { connectionStatus(error.message, true); }
});
$('close-ai').addEventListener('click', () => {
  if (!connecting) {
    $('api-key').value = '';
    $('ai-dialog').close();
  }
});
$('ai-dialog').addEventListener('close', () => { $('api-key').value = ''; });
$('ai-dialog').addEventListener('cancel', event => { if (connecting) event.preventDefault(); });

async function changeConnection(path, payload) {
  if (!aiConnection) throw new Error('Refresh the page and try again.');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 130000);
  try {
    const response = await fetch(path, {
      method: 'POST', signal: controller.signal,
      headers: {'Content-Type': 'application/json', 'X-CSRF-Token': aiConnection.csrf_token},
      body: JSON.stringify(payload),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not update the AI connection.');
    updateConnection(data, true);
  } finally { clearTimeout(timer); }
}

function lockSetup(locked) {
  connecting = locked;
  for (const id of ['test-connect', 'api-key', 'ai-model', 'ai-provider', 'disconnect-ai', 'close-ai']) $(id).disabled = locked;
}

$('ai-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (connecting) return;
  const payload = {provider: $('ai-provider').value, api_key: $('api-key').value.trim(), model: $('ai-model').value.trim()};
  $('api-key').value = '';
  lockSetup(true);
  connectionStatus(payload.provider === 'ollama' ? 'Testing the local model… First load can take a moment.' : 'Testing your key and model with OpenAI…');
  try {
    await changeConnection('/api/ai/connect', payload);
    payload.api_key = '';
    $('ai-dialog').close();
    $('question').focus();
  } catch (error) {
    connectionStatus(error.name === 'AbortError' ? 'Connection test timed out. Please try again.' : error.message, true);
  } finally {
    payload.api_key = '';
    lockSetup(false);
  }
});
$('disconnect-ai').addEventListener('click', async () => {
  lockSetup(true);
  try {
    await changeConnection('/api/ai/disconnect', {});
    connectionStatus('Disconnected. Your workspace is now in Demo mode.');
    $('api-key').value = '';
  } catch (error) { connectionStatus(error.message, true); }
  finally { lockSetup(false); }
});

showSuggestions();
loadSample().then(() => {
  if (location.hash === '#connect-ai') $('connect-ai').click();
});
