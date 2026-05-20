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
      cores     TEXT         DEFAULT '[]',
      qtd       INTEGER      DEFAULT 0,
      preco     DECIMAL(10,2) NOT NULL,
      descricao TEXT         DEFAULT '',
      foto      TEXT         DEFAULT '',
      criado_em TIMESTAMPTZ  DEFAULT NOW()
    )
  `);
  await pool.query(`ALTER TABLE produtos ADD COLUMN IF NOT EXISTS cores TEXT DEFAULT '[]'`);
  await pool.query(`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS mp_payment_id VARCHAR(100) DEFAULT NULL`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pedidos (
      id            BIGSERIAL PRIMARY KEY,
      cliente_nome  VARCHAR(255)   DEFAULT '',
      cliente_cpf   VARCHAR(20)    DEFAULT '',
      cliente_whats VARCHAR(20)    DEFAULT '',
      cep           VARCHAR(9)     DEFAULT '',
      logradouro    VARCHAR(255)   DEFAULT '',
      numero        VARCHAR(20)    DEFAULT '',
      complemento   VARCHAR(100)   DEFAULT '',
      bairro        VARCHAR(100)   DEFAULT '',
      cidade        VARCHAR(100)   DEFAULT '',
      uf            VARCHAR(2)     DEFAULT '',
      frete_tipo    VARCHAR(20)    DEFAULT 'retirada',
      frete_servico VARCHAR(100)   DEFAULT '',
      frete_empresa VARCHAR(100)   DEFAULT '',
      frete_preco   DECIMAL(10,2)  DEFAULT 0,
      frete_prazo   VARCHAR(100)   DEFAULT '',
      me_service_id INTEGER        DEFAULT NULL,
      items         JSONB          DEFAULT '[]',
      subtotal      DECIMAL(10,2)  DEFAULT 0,
      total         DECIMAL(10,2)  DEFAULT 0,
      status        VARCHAR(50)    DEFAULT 'aguardando',
      me_order_id   VARCHAR(100)   DEFAULT NULL,
      etiqueta_url  TEXT           DEFAULT NULL,
      criado_em     TIMESTAMPTZ    DEFAULT NOW()
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
    rows.forEach(r => {
      try { r.cores = JSON.parse(r.cores || '[]'); } catch { r.cores = []; }
    });
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao buscar produtos.' });
  }
});

app.post('/api/produtos', async (req, res) => {
  try {
    const { nome, cores, qtd, preco, descricao, foto } = req.body;
    if (!nome || !preco)
      return res.status(400).json({ erro: 'Nome e preço são obrigatórios.' });

    const coresJson = JSON.stringify(Array.isArray(cores) ? cores : []);
    const { rows } = await pool.query(
      `INSERT INTO produtos (nome, cores, qtd, preco, descricao, foto)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [nome, coresJson, parseInt(qtd) || 0, parseFloat(preco), descricao || '', foto || '']
    );
    const row = rows[0];
    try { row.cores = JSON.parse(row.cores || '[]'); } catch { row.cores = []; }
    res.json(row);
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

// ── pedidos ───────────────────────────────────────────────
app.post('/api/pedidos', async (req, res) => {
  try {
    const {
      cliente_nome, cliente_cpf, cliente_whats,
      cep, logradouro, numero, complemento, bairro, cidade, uf,
      frete_tipo, frete_servico, frete_empresa, frete_preco, frete_prazo,
      me_service_id, items, subtotal, total
    } = req.body;

    const { rows } = await pool.query(`
      INSERT INTO pedidos
        (cliente_nome, cliente_cpf, cliente_whats,
         cep, logradouro, numero, complemento, bairro, cidade, uf,
         frete_tipo, frete_servico, frete_empresa, frete_preco, frete_prazo,
         me_service_id, items, subtotal, total)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
      RETURNING id
    `, [
      cliente_nome || '', cliente_cpf || '', cliente_whats || '',
      cep || '', logradouro || '', numero || '', complemento || '', bairro || '', cidade || '', uf || '',
      frete_tipo || 'retirada', frete_servico || '', frete_empresa || '',
      parseFloat(frete_preco) || 0, frete_prazo || '',
      me_service_id || null, JSON.stringify(items || []),
      parseFloat(subtotal) || 0, parseFloat(total) || 0
    ]);
    res.json({ id: rows[0].id });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao salvar pedido: ' + e.message });
  }
});

app.get('/api/pedidos', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM pedidos ORDER BY criado_em DESC');
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao buscar pedidos.' });
  }
});

app.post('/api/pedidos/:id/etiqueta', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM pedidos WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ erro: 'Pedido não encontrado' });

    const pedido = rows[0];
    if (!pedido.me_service_id) return res.status(400).json({ erro: 'Este pedido não é via Correios.' });

    const token = process.env.ME_TOKEN;
    const headers = {
      'Content-Type':  'application/json',
      'Accept':        'application/json',
      'Authorization': 'Bearer ' + token,
      'User-Agent':    'Hearts Couro (contato@heartscouro.com.br)'
    };

    // Busca dados do remetente na conta ME
    const userRes = await fetch('https://melhorenvio.com.br/api/v2/me/user', { headers });
    const meUser  = await userRes.json();
    if (!meUser.email) return res.status(400).json({ erro: 'Não foi possível buscar dados da conta ME.', detalhe: meUser });

    const items      = Array.isArray(pedido.items) ? pedido.items : JSON.parse(pedido.items || '[]');
    const totalValue = parseFloat(pedido.subtotal) || items.reduce((s, i) => s + i.preco * i.qtd, 0);

    // 1. Adicionar ao carrinho ME
    const cartBody = {
      service: pedido.me_service_id,
      from: {
        name:             (meUser.firstname || '') + ' ' + (meUser.lastname || ''),
        phone:            meUser.phone || '',
        email:            meUser.email,
        document:         meUser.document || '',
        company_document: meUser.company?.document || meUser.document || '',
        state_register:   'Isento',
        address:          meUser.address?.address  || '',
        complement:       meUser.address?.complement || '',
        number:           meUser.address?.number    || '',
        district:         meUser.address?.district  || '',
        city:             meUser.address?.city      || '',
        state_abbr:       meUser.address?.state_abbr || '',
        country_id:       'BR',
        postal_code:      (process.env.CEP_ORIGEM || '').replace(/\D/g, '')
      },
      to: {
        name:       pedido.cliente_nome,
        phone:      pedido.cliente_whats || '',
        email:      '',
        document:   pedido.cliente_cpf,
        address:    pedido.logradouro,
        complement: pedido.complemento || '',
        number:     pedido.numero,
        district:   pedido.bairro,
        city:       pedido.cidade,
        state_abbr: pedido.uf,
        country_id: 'BR',
        postal_code: pedido.cep.replace(/\D/g, '')
      },
      products: items.map(i => ({
        name:          i.nome + (i.cor ? ' - ' + i.cor : ''),
        quantity:      i.qtd,
        unitary_value: i.preco
      })),
      volumes: [{
        height: Number(process.env.PKG_ALTURA)  || 10,
        width:  Number(process.env.PKG_LARGURA) || 20,
        length: Number(process.env.PKG_COMP)    || 30,
        weight: Number(process.env.PKG_PESO)    || 0.5
      }],
      options: {
        insurance_value: totalValue,
        receipt:         false,
        own_hand:        false,
        reverse:         false,
        non_commercial:  false,
        platform:        'Hearts Couro'
      }
    };

    const cartRes  = await fetch('https://melhorenvio.com.br/api/v2/me/cart', { method: 'POST', headers, body: JSON.stringify(cartBody) });
    const cartData = await cartRes.json();
    if (!cartData.id) return res.status(400).json({ erro: 'Erro ao adicionar ao carrinho ME.', detalhe: cartData });
    const meOrderId = cartData.id;

    // 2. Checkout (debita saldo ME)
    await fetch('https://melhorenvio.com.br/api/v2/me/shipment/checkout', {
      method: 'POST', headers, body: JSON.stringify({ orders: [meOrderId] })
    });

    // 3. Gerar etiqueta
    await fetch('https://melhorenvio.com.br/api/v2/me/shipment/generate', {
      method: 'POST', headers, body: JSON.stringify({ orders: [meOrderId] })
    });

    // 4. URL de impressão
    const printRes  = await fetch(`https://melhorenvio.com.br/api/v2/me/shipment/print?orders[]=${meOrderId}`, { headers });
    const printData = await printRes.json();
    const etiquetaUrl = printData.url || '';

    await pool.query(
      `UPDATE pedidos SET me_order_id=$1, etiqueta_url=$2, status='etiqueta_gerada' WHERE id=$3`,
      [meOrderId, etiquetaUrl, req.params.id]
    );

    res.json({ ok: true, etiqueta_url: etiquetaUrl, me_order_id: meOrderId });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao gerar etiqueta: ' + e.message });
  }
});

// ── pagamento — Mercado Pago (token fica só no servidor) ──
app.post('/api/mp/preferencia', async (req, res) => {
  try {
    const { items, nome_cliente, pedido_id } = req.body;
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
        payment_methods: { installments: 12 },
        external_reference: pedido_id ? String(pedido_id) : undefined,
        notification_url: (process.env.BASE_URL || '') + '/api/webhooks/mp'
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

app.post('/api/pedidos/:id/cancelar-etiqueta', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM pedidos WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ erro: 'Pedido não encontrado' });

    const pedido = rows[0];
    if (!pedido.me_order_id) return res.status(400).json({ erro: 'Este pedido não tem etiqueta gerada.' });

    const token = process.env.ME_TOKEN;
    const headers = {
      'Content-Type':  'application/json',
      'Accept':        'application/json',
      'Authorization': 'Bearer ' + token,
      'User-Agent':    'Hearts Couro (contato@heartscouro.com.br)'
    };

    const r = await fetch(`https://melhorenvio.com.br/api/v2/me/cart/${pedido.me_order_id}`, {
      method: 'DELETE',
      headers
    });

    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      return res.status(400).json({ erro: 'Melhor Envios recusou o cancelamento.', detalhe: err });
    }

    await pool.query(
      `UPDATE pedidos SET status = 'pago', me_order_id = NULL, etiqueta_url = NULL WHERE id = $1`,
      [req.params.id]
    );

    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao cancelar etiqueta: ' + e.message });
  }
});

// ── webhook Mercado Pago ──────────────────────────────────
app.post('/api/webhooks/mp', async (req, res) => {
  res.sendStatus(200); // responde imediatamente para o MP não reenviar

  try {
    const { type, data, topic, id: ipnId } = req.body;

    // Suporta formato webhook (type/data) e IPN antigo (topic/id)
    const paymentId = data?.id || (topic === 'payment' ? ipnId : null);
    if (!paymentId) return;
    if (type && type !== 'payment') return;

    const token = process.env.MP_ACCESS_TOKEN;
    const r = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    const payment = await r.json();

    if (payment.status !== 'approved') return;

    const pedidoId = payment.external_reference;
    if (!pedidoId) return;

    await pool.query(
      `UPDATE pedidos SET status = 'pago', mp_payment_id = $1 WHERE id = $2 AND status != 'etiqueta_gerada'`,
      [String(paymentId), pedidoId]
    );
    console.log(`✅ Pedido #${pedidoId} marcado como pago (MP payment ${paymentId})`);
  } catch (e) {
    console.error('Webhook MP erro:', e.message);
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
