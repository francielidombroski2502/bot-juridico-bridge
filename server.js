const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

const TYPEBOT_ID = process.env.TYPEBOT_ID || 'my-typebot-7k1y6pr';
const TYPEBOT_API = 'https://typebot.io/api/v1';
const ZAPI_INSTANCE = process.env.ZAPI_INSTANCE || '3F1BE1A0F195F1D38E0DBA4D31290A14';
const ZAPI_TOKEN = process.env.ZAPI_TOKEN || '3104C24CB6AE995F0E97E070';
const ZAPI_URL = `https://api.z-api.io/instances/${ZAPI_INSTANCE}/token/${ZAPI_TOKEN}`;
const PORT = process.env.PORT || 3000;

const sessions = new Map();
const SESSION_TIMEOUT_MS = 30 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  let removed = 0;
  for (const [phone, session] of sessions.entries()) {
    if (now - session.lastActivity > SESSION_TIMEOUT_MS) {
      sessions.delete(phone);
      removed++;
    }
  }
  if (removed > 0) console.log(`[SESSION] ${removed} sessao(oes) expirada(s) removida(s).`);
}, 15 * 60 * 1000);

async function startChat(phone) {
  console.log(`[TYPEBOT] Iniciando nova sessao para ${phone}`);
  const res = await axios.post(`${TYPEBOT_API}/typebots/${TYPEBOT_ID}/startChat`, {
    startParams: { isPreview: false }
  });
  sessions.set(phone, { sessionId: res.data.sessionId, lastActivity: Date.now() });
  return res.data;
}

async function continueChat(phone, message) {
  const session = sessions.get(phone);
  if (!session) return startChat(phone);
  const res = await axios.post(`${TYPEBOT_API}/typebots/${TYPEBOT_ID}/continueChat`, {
    sessionId: session.sessionId,
    message
  });
  session.lastActivity = Date.now();
  if (res.data.isEnded) sessions.delete(phone);
  return res.data;
}

function parseRichText(richText) {
  if (!richText || !Array.isArray(richText)) return '';
  return richText.map(block => {
    if (!block.children) return '';
    return block.children.map(child => {
      let text = child.text || '';
      if (!text) return '';
      if (child.bold) text = `*${text}*`;
      if (child.italic) text = `_${text}_`;
      return text;
    }).join('');
  }).join('\n');
}

const delay = ms => new Promise(r => setTimeout(r, ms));

async function sendText(phone, message) {
  if (!message || !message.trim()) return;
  return axios.post(`${ZAPI_URL}/send-text`, { phone, message });
}

async function sendOptionList(phone, message, options) {
  return axios.post(`${ZAPI_URL}/send-option-list`, {
    phone,
    message,
    optionList: {
      title: 'Opcoes disponiveis',
      buttonLabel: 'Ver opcoes',
      sections: [{
        title: 'Selecione uma opcao:',
        rows: options.map((opt, i) => ({ rowId: `row_${i}`, title: opt, description: '' }))
      }]
    }
  });
}

async function sendButtons(phone, message, buttons) {
  return axios.post(`${ZAPI_URL}/send-button-list`, {
    phone,
    message,
    buttonList: {
      buttons: buttons.map((btn, i) => ({
        buttonId: `opt_${i}`,
        buttonText: { displayText: btn }
      }))
    }
  });
}

async function processTypebotResponse(phone, data) {
  const { messages = [], input } = data;
  for (const msg of messages) {
    if (msg.type === 'text') {
      const text = parseRichText(msg.content && msg.content.richText);
      if (text.trim()) {
        await sendText(phone, text);
        await delay(700);
      }
    }
  }
  if (input && input.type === 'choice input') {
    const options = (input.options || []).map(o => o.content).filter(Boolean);
    if (options.length > 0) {
      await delay(400);
      try {
        if (options.length <= 3) {
          await sendButtons(phone, 'Selecione uma opcao:', options);
        } else {
          await sendOptionList(phone, 'Selecione uma opcao:', options);
        }
      } catch (btnErr) {
        const fallback = options.map((opt, i) => `${i + 1}. ${opt}`).join('\n');
        await sendText(phone, `Escolha uma opcao respondendo com o numero:\n\n${fallback}`);
      }
    }
  }
}

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  const { phone, fromMe, text, momType, listResponseMessage, buttonsResponseMessage } = req.body;
  try {
    if (fromMe) return;
    let userMessage = '';
    if (momType === 'text') {
      userMessage = (text && text.message) || '';
    } else if (momType === 'listResponseMessage') {
      userMessage = (listResponseMessage && (listResponseMessage.title || listResponseMessage.description)) || '';
    } else if (momType === 'buttonsResponseMessage') {
      userMessage = (buttonsResponseMessage && buttonsResponseMessage.selectedDisplayText) || '';
    } else {
      return;
    }
    if (!userMessage.trim()) return;
    console.log(`[WEBHOOK] Mensagem de ${phone}: "${userMessage}"`);
    const session = sessions.get(phone);
    const result = session ? await continueChat(phone, userMessage) : await startChat(phone);
    await processTypebotResponse(phone, result);
  } catch (err) {
    console.error(`[ERRO] ${phone}:`, err.message);
    try { await sendText(phone, 'Ocorreu um erro. Por favor, envie uma mensagem novamente.'); } catch (_) {}
  }
});

app.get('/', (req, res) => {
  res.json({ status: 'Bot Juridico ativo!', sessoes_ativas: sessions.size, uptime: Math.floor(process.uptime()) });
});

app.get('/health', (req, res) => res.json({ status: 'ok', sessions: sessions.size }));

app.delete('/session/:phone', (req, res) => {
  const phone = req.params.phone;
  if (sessions.has(phone)) {
    sessions.delete(phone);
    res.json({ message: `Sessao de ${phone} removida.` });
  } else {
    res.status(404).json({ message: 'Sessao nao encontrada.' });
  }
});

app.listen(PORT, () => {
  console.log(`Bot Juridico rodando na porta ${PORT}`);
});
