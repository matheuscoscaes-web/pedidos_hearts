require('dotenv').config();
const express = require('express');
const { Pool }  = require('pg');
const path      = require('path');

const app = express();
app.use(express.json({ limit: '10mb' })); // aceita fotos em base64
app.use(express.static(path.join(__dirname)));

// ── banco de dados ────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost')
    ? false
    : { rejectUnauthorized: false }
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS produtos (
      id        BIGSERIAL PRIMARY KEY,
      nome      VARCHAR(255) NOT NULL,
      cor       VARCHAR(100) DEFAULT '',
      qtd       INTEGER      DEFAULT 0,
      preco     DECIMAL(10,2) NOT NULL,
      descricao TEXT         DEFAULT '',
      foto      TEXT         DEFAULT '',
      criado_em TIMESTAMPTZ  DEFAULT NOW()
    )
  `);
  console.log('✅ Banco de dados pronto.');
}

// ── config público (sem segredos) ─────────────────────────
app.get('/api/config', (req, res) => {
  res.json({
    base_url:  process.env.BASE_URL || `${req.protocol}://${req.get('host')}`,
    wpp_admin: process.env.WPP_ADMIN || ''
  });
});

// ── produtos ──────────────────────────────────────────────
app.get('/api/produtos', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM produtos ORDER BY criado_em DESC'
    );
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao buscar produtos.' });
  }
});

app.post('/api/produtos', async (req, res) => {
  try {
    const { nome, cor, qtd, preco, descricao, foto } = req.body;
    if (!nome || !preco)
      return res.status(400).json({ erro: 'Nome e preço são obrigatórios.' });

    const { rows } = await pool.query(
      `INSERT INTO produtos (nome, cor, qtd, preco, descricao, foto)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [nome, cor || '', parseInt(qtd) || 0, parseFloat(preco), descricao || '', foto || '']
    );
    res.json(rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao salvar produto.' });
  }
});

app.delete('/api/produtos/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM produtos WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao deletar produto.' });
  }
});

// ── frete — Melhor Envios (servidor evita problema de CORS) ─
app.post('/api/frete', async (req, res) => {
  try {
    const { cep_destino } = req.body;
    const token   = process.env.ME_TOKEN;
    const cep_orig = process.env.CEP_ORIGEM;

    if (!token || !cep_orig)
      return res.status(400).json({ erro: 'ME_TOKEN e CEP_ORIGEM não estão no .env' });

    const r = await fetch('https://melhorenvio.com.br/api/v2/me/shipment/calculate', {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Accept':        'application/json',
        'Authorization': 'Bearer ' + token,
        'User-Agent':    'Hearts Couro (contato@heartscouro.com.br)'
      },
      body: JSON.stringify({
        from: { postal_code: cep_orig.replace(/\D/g, '') },
        to:   { postal_code: cep_destino.replace(/\D/g, '') },
        package: {
          height: Number(process.env.PKG_ALTURA)  || 10,
          width:  Number(process.env.PKG_LARGURA) || 20,
          length: Number(process.env.PKG_COMP)    || 30,
          weight: Number(process.env.PKG_PESO)    || 0.5
        },
        options: { receipt: false, own_hand: false }
      })
    });

    const data = await r.json();
    res.json(data);
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao calcular frete: ' + e.message });
  }
});

// ── pagamento — Mercado Pago (token fica só no servidor) ──
app.post('/api/mp/preferencia', async (req, res) => {
  try {
    const { items, nome_cliente } = req.body;
    const token = process.env.MP_ACCESS_TOKEN;

    if (!token)
      return res.status(400).json({ erro: 'MP_ACCESS_TOKEN não está no .env' });

    const r = await fetch('https://api.mercadopago.com/checkout/preferences', {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': 'Bearer ' + token
      },
      body: JSON.stringify({
        items,
        payer: { name: nome_cliente || 'Cliente' },
        statement_descriptor: 'Hearts Couro',
        payment_methods: { installments: 12 }
      })
    });

    const data = await r.json();
    if (!data.init_point)
      return res.status(400).json({ erro: 'Resposta inesperada do MP', detalhe: data });

    res.json({ mp_link: data.init_point });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro MP: ' + e.message });
  }
});

// ── start ─────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
initDB()
  .then(() => app.listen(PORT, () =>
    console.log(`🚀 Servidor rodando em http://localhost:${PORT}`)
  ))
  .catch(e => {
    console.error('❌ Erro ao conectar no banco:', e.message);
    process.exit(1);
  });
