const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

// =============================================
// CONFIGURAÇÃO
// =============================================
const TYPEBOT_ID = process.env.TYPEBOT_ID || 'my-typebot-7k1y6pr';
const TYPEBOT_API = 'https://typebot.io/api/v1';
const ZAPI_INSTANCE = process.env.ZAPI_INSTANCE || '3F1BE1A0F195F1D38E0DBA4D31290A14';
const ZAPI_TOKEN = process.env.ZAPI_TOKEN || '3104C24CB6AE995F0E97E070';
const ZAPI_URL = `https://api.z-api.io/instances/${ZAPI_INSTANCE}/token/${ZAPI_TOKEN}`;
const ZAPI_CLIENT_TOKEN = process.env.ZAPI_CLIENT_TOKEN || 'Ff99ea36ae8844423aef6b96164d87d25S';
const ZAPI_HEADERS = { 'Content-Type': 'application/json', 'Client-Token': ZAPI_CLIENT_TOKEN };
const PORT = process.env.PORT || 3000;

// =============================================
// GERENCIAMENTO DE SESSÕES
// =============================================
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
  if (removed > 0) console.log(`[SESSION] ${removed} sessão(ões) expirada(s) removida(s).`);
}, 15 * 60 * 1000);

// =============================================
// TYPEBOT API
// =============================================
async function startChat(phone) {
  console.log(`[TYPEBOT] Iniciando nova sessão para ${phone}`);
  const res = await axios.post(`${TYPEBOT_API}/typebots/${TYPEBOT_ID}/startChat`, {
    startParams: { isPreview: false }
  });
  sessions.set(phone, { sessionId: res.data.sessionId, lastActivity: Date.now() });
  console.log(`[TYPEBOT] Sessão criada: ${res.data.sessionId}`);
  return res.data;
}

async function continueChat(phone, message) {
  const session = sessions.get(phone);
  if (!session) {
    console.log(`[TYPEBOT] Sem sessão ativa para ${phone} — iniciando nova`);
    return startChat(phone);
  }
  console.log(`[TYPEBOT] Continuando sessão ${session.sessionId} | msg: "${message}"`);
  const res = await axios.post(`${TYPEBOT_API}/typebots/${TYPEBOT_ID}/continueChat`, {
    sessionId: session.sessionId,
    message
  });
  session.lastActivity = Date.now();
  if (res.data.isEnded) {
    console.log(`[TYPEBOT] Conversa encerrada para ${phone}`);
    sessions.delete(phone);
  }
  return res.data;
}

// =============================================
// PARSER DE MENSAGENS TYPEBOT
// =============================================
function parseRichText(richText) {
  if (!richText || !Array.isArray(richText)) return '';
  return richText.map(block => {
    if (!block.children) return '';
    return block.children.map(child => {
      let text = child.text || '';
      if (!text) return '';
      if (child.bold) text = `*${text}*`;
      if (child.italic) text = `_${text}_`;
      if (child.underline) text = `~${text}~`;
      return text;
    }).join('');
  }).join('\n');
}

// =============================================
// Z-API SENDER
// =============================================
const delay = ms => new Promise(r => setTimeout(r, ms));

async function sendText(phone, message) {
  if (!message || !message.trim()) return;
  console.log(`[ZAPI] Enviando texto para ${phone}: "${message.substring(0, 60)}"`);
  return axios.post(`${ZAPI_URL}/send-text`, { phone, message }, { headers: ZAPI_HEADERS });
}

async function sendButtons(phone, message, buttons) {
  console.log(`[ZAPI] Enviando ${buttons.length} botões para ${phone}`);
  return axios.post(`${ZAPI_URL}/send-button-list`, {
    phone,
    message,
    buttonList: {
      buttons: buttons.map((btn, i) => ({
        buttonId: `opt_${i}`,
        buttonText: { displayText: btn }
      }))
    }
  }, { headers: ZAPI_HEADERS });
}

async function sendOptionList(phone, message, options) {
  console.log(`[ZAPI] Enviando lista de ${options.length} opções para ${phone}`);
  return axios.post(`${ZAPI_URL}/send-option-list`, {
    phone,
    message,
    optionList: {
      title: 'Opcoes disponiveis',
      buttonLabel: 'Ver opcoes',
      sections: [{
        title: 'Selecione uma opcao:',
        rows: options.map((opt, i) => ({
          rowId: `row_${i}`,
          title: opt,
          description: ''
        }))
      }]
    }
  }, { headers: ZAPI_HEADERS });
}

// =============================================
// PROCESSAR RESPOSTA DO TYPEBOT
// =============================================
async function processTypebotResponse(phone, data) {
  const { messages = [], input } = data;
  for (const msg of messages) {
    if (msg.type === 'text') {
      const text = parseRichText(msg.content?.richText);
      if (text.trim()) {
        await sendText(phone, text);
        await delay(700);
      }
    }
  }
  if (input) {
    if (input.type === 'choice input') {
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
          console.warn('[ZAPI] Botoes falharam, usando fallback texto:', btnErr.message);
          const fallback = options.map((opt, i) => `${i + 1}. ${opt}`).join('\n');
          await sendText(phone, `Escolha uma opcao respondendo com o numero:\n\n${fallback}`);
        }
      }
    }
  }
}

// =============================================
// WEBHOOK
// =============================================
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  const { phone, fromMe, text, momType, listResponseMessage, buttonsResponseMessage } = req.body;
  try {
    if (fromMe) return;
    let userMessage = '';
    if (momType === 'text') {
      userMessage = text?.message || '';
    } else if (momType === 'listResponseMessage') {
      userMessage = listResponseMessage?.title || listResponseMessage?.description || '';
    } else if (momType === 'buttonsResponseMessage') {
      userMessage = buttonsResponseMessage?.selectedDisplayText || '';
    } else {
      return;
    }
    if (!userMessage.trim()) return;
    console.log(`\n[WEBHOOK] Mensagem de ${phone}: "${userMessage}"`);
    const session = sessions.get(phone);
    const result = session
      ? await continueChat(phone, userMessage)
      : await startChat(phone);
    await processTypebotResponse(phone, result);
  } catch (err) {
    console.error(`[ERRO] Processando mensagem de ${phone}:`, err.message);
    if (err.response?.data) console.error('[ERRO] Resposta API:', JSON.stringify(err.response.data));
    try { await sendText(phone, 'Ocorreu um erro. Por favor, envie uma mensagem novamente.'); } catch (_) {}
  }
});

// =============================================
// ROTAS UTILITÁRIAS
// =============================================
app.get('/', (req, res) => {
  res.json({ status: 'Bot Juridico ativo!', sessoes_ativas: sessions.size, uptime_segundos: Math.floor(process.uptime()), timestamp: new Date().toISOString() });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', sessions: sessions.size });
});

app.delete('/session/:phone', (req, res) => {
  const phone = req.params.phone;
  if (sessions.has(phone)) {
    sessions.delete(phone);
    res.json({ message: `Sessão de ${phone} removida.` });
  } else {
    res.status(404).json({ message: 'Sessão não encontrada.' });
  }
});

// =============================================
// INICIALIZAÇÃO
// =============================================
app.listen(PORT, () => {
  console.log(`\nBot Juridico rodando na porta ${PORT}`);
  console.log(`Webhook URL: POST /webhook`);
  console.log(`Status URL: GET /\n`);
});
