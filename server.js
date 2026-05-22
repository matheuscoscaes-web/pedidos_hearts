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
      id          BIGSERIAL PRIMARY KEY,
      nome        VARCHAR(255) NOT NULL,
      cor         VARCHAR(100) DEFAULT '',
      cores       TEXT         DEFAULT '[]',
      qtd         INTEGER      DEFAULT 0,
      preco       DECIMAL(10,2) NOT NULL,
      descricao   TEXT         DEFAULT '',
      foto        TEXT         DEFAULT '',
      altura        DECIMAL(10,2)  DEFAULT 0,
      largura       DECIMAL(10,2)  DEFAULT 0,
      comprimento   DECIMAL(10,2)  DEFAULT 0,
      peso          DECIMAL(10,3)  DEFAULT 0,
      prazo_entrega VARCHAR(100)   DEFAULT '',
      criado_em     TIMESTAMPTZ    DEFAULT NOW()
    )
  `);
  await pool.query(`ALTER TABLE produtos ADD COLUMN IF NOT EXISTS cores TEXT DEFAULT '[]'`);
  await pool.query(`ALTER TABLE produtos ADD COLUMN IF NOT EXISTS altura        DECIMAL(10,2)  DEFAULT 0`);
  await pool.query(`ALTER TABLE produtos ADD COLUMN IF NOT EXISTS largura       DECIMAL(10,2)  DEFAULT 0`);
  await pool.query(`ALTER TABLE produtos ADD COLUMN IF NOT EXISTS comprimento   DECIMAL(10,2)  DEFAULT 0`);
  await pool.query(`ALTER TABLE produtos ADD COLUMN IF NOT EXISTS peso          DECIMAL(10,3)  DEFAULT 0`);
  await pool.query(`ALTER TABLE produtos ADD COLUMN IF NOT EXISTS prazo_entrega VARCHAR(100)   DEFAULT ''`);
  await pool.query(`ALTER TABLE produtos ADD COLUMN IF NOT EXISTS fotos TEXT DEFAULT '[]'`);
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
      try {
        const parsed = JSON.parse(r.cores || '[]');
        // Normaliza formato antigo (array de strings) para [{nome, qtd}]
        r.cores = parsed.map(c => typeof c === 'string' ? { nome: c, qtd: 0 } : c);
      } catch { r.cores = []; }
    });
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao buscar produtos.' });
  }
});

app.post('/api/produtos', async (req, res) => {
  try {
    const { nome, cores, qtd, preco, descricao, foto, fotos, altura, largura, comprimento, peso, prazo_entrega } = req.body;
    if (!nome || !preco)
      return res.status(400).json({ erro: 'Nome e preço são obrigatórios.' });

    // Normaliza cores para [{nome, qtd}] e calcula estoque total
    const coresNorm = (Array.isArray(cores) ? cores : []).map(c =>
      typeof c === 'string' ? { nome: c, qtd: 0 } : { nome: c.nome || '', qtd: parseInt(c.qtd) || 0 }
    );
    const qtdTotal = coresNorm.length && coresNorm.some(c => c.qtd > 0)
      ? coresNorm.reduce((s, c) => s + (c.qtd || 0), 0)
      : parseInt(qtd) || 0;
    const coresJson = JSON.stringify(coresNorm);
    const { rows } = await pool.query(
      `INSERT INTO produtos (nome, cores, qtd, preco, descricao, foto, fotos, altura, largura, comprimento, peso, prazo_entrega)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
      [nome, coresJson, qtdTotal, parseFloat(preco), descricao || '', foto || '',
       JSON.stringify(Array.isArray(fotos) ? fotos : (foto ? [foto] : [])),
       parseFloat(altura) || 0, parseFloat(largura) || 0, parseFloat(comprimento) || 0, parseFloat(peso) || 0,
       prazo_entrega || '']
    );
    const row = rows[0];
    try {
      const parsed = JSON.parse(row.cores || '[]');
      row.cores = parsed.map(c => typeof c === 'string' ? { nome: c, qtd: 0 } : c);
    } catch { row.cores = []; }
    res.json(row);
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao salvar produto.' });
  }
});

app.put('/api/produtos/:id/dimensoes', async (req, res) => {
  try {
    const { altura, largura, comprimento, peso } = req.body;
    const { rows } = await pool.query(
      `UPDATE produtos SET altura=$1, largura=$2, comprimento=$3, peso=$4 WHERE id=$5 RETURNING *`,
      [parseFloat(altura)||0, parseFloat(largura)||0, parseFloat(comprimento)||0, parseFloat(peso)||0, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ erro: 'Produto não encontrado.' });
    res.json(rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao atualizar produto.' });
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
    const { cep_destino, items } = req.body;
    const token    = process.env.ME_TOKEN;
    const cep_orig = process.env.CEP_ORIGEM;

    if (!token || !cep_orig)
      return res.status(400).json({ erro: 'ME_TOKEN e CEP_ORIGEM não estão no .env' });

    // Dimensões padrão (fallback para produtos sem dimensões cadastradas)
    let pkg = {
      height: Number(process.env.PKG_ALTURA)  || 10,
      width:  Number(process.env.PKG_LARGURA) || 20,
      length: Number(process.env.PKG_COMP)    || 30,
      weight: Number(process.env.PKG_PESO)    || 0.5
    };

    // Calcula dimensões reais a partir dos produtos do carrinho
    if (Array.isArray(items) && items.length) {
      const ids = items.map(i => Number(i.id)).filter(Boolean);
      if (ids.length) {
        const { rows: prods } = await pool.query(
          `SELECT id, altura, largura, comprimento, peso FROM produtos WHERE id = ANY($1)`,
          [ids]
        );
        const prodMap = Object.fromEntries(prods.map(p => [p.id, p]));

        const pesoMargem = 1 + (Number(process.env.PESO_MARGEM) || 0) / 100;
        let totalPeso = 0, maxAltura = 0, maxLargura = 0, maxComp = 0, temDimensoes = false;
        for (const item of items) {
          const p = prodMap[Number(item.id)];
          if (p && (parseFloat(p.peso) > 0 || parseFloat(p.altura) > 0)) {
            temDimensoes = true;
            totalPeso += parseFloat(p.peso || 0) * (item.qtd || 1);
            maxAltura  = Math.max(maxAltura,  parseFloat(p.altura      || 0));
            maxLargura = Math.max(maxLargura, parseFloat(p.largura     || 0));
            maxComp    = Math.max(maxComp,    parseFloat(p.comprimento || 0));
          }
        }
        if (temDimensoes) {
          pkg = {
            height: maxAltura  || pkg.height,
            width:  maxLargura || pkg.width,
            length: maxComp    || pkg.length,
            weight: (totalPeso * pesoMargem) || pkg.weight
          };
        }
      }
    }

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
        package: pkg,
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

async function meJson(response, label) {
  const text = await response.text();
  if (!response.ok || text.trimStart().startsWith('<')) {
    const preview = text.replace(/\s+/g, ' ').trim().slice(0, 300);
    throw new Error(`ME API "${label}" status ${response.status} — resposta: ${preview}`);
  }
  try { return JSON.parse(text); }
  catch { throw new Error(`ME API "${label}" retornou resposta inválida (status ${response.status}).`); }
}

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

    // Busca endereço do remetente via ViaCEP (não depende da ME API)
    const cepOrig = (process.env.CEP_ORIGEM || '').replace(/\D/g, '');
    const cepRes  = await fetch(`https://viacep.com.br/ws/${cepOrig}/json/`);
    const cepData = await cepRes.json();
    if (cepData.erro) return res.status(400).json({ erro: 'CEP_ORIGEM inválido no .env' });

    const items      = Array.isArray(pedido.items) ? pedido.items : JSON.parse(pedido.items || '[]');
    const totalValue = parseFloat(pedido.subtotal) || items.reduce((s, i) => s + i.preco * i.qtd, 0);

    // Busca dimensões reais dos produtos para calcular o volume da embalagem
    let volumes = [{
      height: Number(process.env.PKG_ALTURA)  || 10,
      width:  Number(process.env.PKG_LARGURA) || 20,
      length: Number(process.env.PKG_COMP)    || 30,
      weight: Number(process.env.PKG_PESO)    || 0.5
    }];
    const prodIds = items.map(i => Number(i.id)).filter(Boolean);
    if (prodIds.length) {
      const { rows: prods } = await pool.query(
        `SELECT id, altura, largura, comprimento, peso FROM produtos WHERE id = ANY($1)`,
        [prodIds]
      );
      const prodMap = Object.fromEntries(prods.map(p => [p.id, p]));
      const pesoMargem = 1 + (Number(process.env.PESO_MARGEM) || 0) / 100;
      let totalPeso = 0, maxAltura = 0, maxLargura = 0, maxComp = 0, temDimensoes = false;
      for (const item of items) {
        const p = prodMap[Number(item.id)];
        if (p && (parseFloat(p.peso) > 0 || parseFloat(p.altura) > 0)) {
          temDimensoes = true;
          totalPeso += parseFloat(p.peso || 0) * (item.qtd || 1);
          maxAltura  = Math.max(maxAltura,  parseFloat(p.altura      || 0));
          maxLargura = Math.max(maxLargura, parseFloat(p.largura     || 0));
          maxComp    = Math.max(maxComp,    parseFloat(p.comprimento || 0));
        }
      }
      if (temDimensoes) {
        volumes = [{
          height: maxAltura  || volumes[0].height,
          width:  maxLargura || volumes[0].width,
          length: maxComp    || volumes[0].length,
          weight: (totalPeso * pesoMargem) || volumes[0].weight
        }];
      }
    }

    // 1. Adicionar ao carrinho ME
    const cartBody = {
      service: pedido.me_service_id,
      from: {
        name:             process.env.ME_NOME      || 'Hearts Couro',
        phone:            (process.env.ME_TELEFONE || '').replace(/\D/g, ''),
        email:            process.env.ME_EMAIL     || '',
        document:         (process.env.ME_CPF      || '').replace(/\D/g, ''),
        company_document: (process.env.ME_CPF      || '').replace(/\D/g, ''),
        state_register:   'Isento',
        address:          cepData.logradouro || '',
        complement:       '',
        number:           process.env.ME_NUMERO    || '',
        district:         cepData.bairro    || '',
        city:             cepData.localidade || '',
        state_abbr:       cepData.uf         || '',
        country_id:       'BR',
        postal_code:      cepOrig
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
      volumes,
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
    const cartData = await meJson(cartRes, 'cart');
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
    const printData = await meJson(printRes, 'print');
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

// ── Melhor Envio — enviar pedido para Minhas Vendas ──────
app.post('/api/pedidos/:id/enviar-me', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM pedidos WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ erro: 'Pedido não encontrado' });

    const pedido = rows[0];
    if (!pedido.me_service_id) return res.status(400).json({ erro: 'Este pedido não é via Correios.' });

    const token = process.env.ME_TOKEN;
    if (!token) return res.status(400).json({ erro: 'ME_TOKEN não configurado no .env' });

    const headers = {
      'Content-Type':  'application/json',
      'Accept':        'application/json',
      'Authorization': 'Bearer ' + token,
      'User-Agent':    'Hearts Couro (contato@heartscouro.com.br)'
    };

    const items = Array.isArray(pedido.items) ? pedido.items : JSON.parse(pedido.items || '[]');
    const totalValue = parseFloat(pedido.subtotal) || items.reduce((s, i) => s + i.preco * i.qtd, 0);

    let volumes = [{
      height: Number(process.env.PKG_ALTURA)  || 10,
      width:  Number(process.env.PKG_LARGURA) || 20,
      length: Number(process.env.PKG_COMP)    || 30,
      weight: Number(process.env.PKG_PESO)    || 0.5
    }];
    const prodIds = items.map(i => Number(i.id)).filter(Boolean);
    if (prodIds.length) {
      const { rows: prods } = await pool.query(
        `SELECT id, altura, largura, comprimento, peso FROM produtos WHERE id = ANY($1)`, [prodIds]
      );
      const prodMap = Object.fromEntries(prods.map(p => [p.id, p]));
      const pesoMargem = 1 + (Number(process.env.PESO_MARGEM) || 0) / 100;
      let totalPeso = 0, maxAltura = 0, maxLargura = 0, maxComp = 0, temDimensoes = false;
      for (const item of items) {
        const p = prodMap[Number(item.id)];
        if (p && (parseFloat(p.peso) > 0 || parseFloat(p.altura) > 0)) {
          temDimensoes = true;
          totalPeso += parseFloat(p.peso || 0) * (item.qtd || 1);
          maxAltura  = Math.max(maxAltura,  parseFloat(p.altura      || 0));
          maxLargura = Math.max(maxLargura, parseFloat(p.largura     || 0));
          maxComp    = Math.max(maxComp,    parseFloat(p.comprimento || 0));
        }
      }
      if (temDimensoes) {
        volumes = [{
          height: maxAltura  || volumes[0].height,
          width:  maxLargura || volumes[0].width,
          length: maxComp    || volumes[0].length,
          weight: (totalPeso * pesoMargem) || volumes[0].weight
        }];
      }
    }

    // Busca endereço do remetente via ViaCEP
    const cepOrig = (process.env.CEP_ORIGEM || '').replace(/\D/g, '');
    const cepRes  = await fetch(`https://viacep.com.br/ws/${cepOrig}/json/`);
    const cepData = await cepRes.json();
    if (cepData.erro) return res.status(400).json({ erro: 'CEP_ORIGEM inválido no .env' });

    const cartBody = {
      service: pedido.me_service_id,
      from: {
        name:             process.env.ME_NOME      || 'Hearts Couro',
        phone:            (process.env.ME_TELEFONE || '').replace(/\D/g, ''),
        email:            process.env.ME_EMAIL     || '',
        document:         (process.env.ME_CPF      || '').replace(/\D/g, ''),
        company_document: (process.env.ME_CPF      || '').replace(/\D/g, ''),
        state_register:   'Isento',
        address:          cepData.logradouro || '',
        complement:       '',
        number:           process.env.ME_NUMERO    || '',
        district:         cepData.bairro    || '',
        city:             cepData.localidade || '',
        state_abbr:       cepData.uf         || '',
        country_id:       'BR',
        postal_code:      cepOrig
      },
      to: {
        name:        pedido.cliente_nome,
        phone:       (pedido.cliente_whats || '').replace(/\D/g, ''),
        email:       '',
        document:    (pedido.cliente_cpf   || '').replace(/\D/g, ''),
        address:     pedido.logradouro,
        complement:  pedido.complemento || '',
        number:      pedido.numero,
        district:    pedido.bairro,
        city:        pedido.cidade,
        state_abbr:  pedido.uf,
        country_id:  'BR',
        postal_code: pedido.cep.replace(/\D/g, '')
      },
      products: items.map(i => ({
        name:          i.nome + (i.cor ? ' - ' + i.cor : ''),
        quantity:      i.qtd,
        unitary_value: parseFloat(i.preco)
      })),
      volumes,
      options: {
        insurance_value: totalValue,
        receipt:         false,
        own_hand:        false,
        reverse:         false,
        non_commercial:  false,
        platform:        'Hearts Couro'
      }
    };

    const cartRes  = await fetch('https://melhorenvio.com.br/api/v2/me/cart', {
      method: 'POST', headers, body: JSON.stringify(cartBody)
    });
    const cartData = await meJson(cartRes, 'cart');
    if (!cartData.id) return res.status(400).json({ erro: 'Erro ao adicionar ao carrinho ME.', detalhe: cartData });

    await pool.query(
      `UPDATE pedidos SET me_order_id = $1 WHERE id = $2`,
      [String(cartData.id), req.params.id]
    );

    res.json({ ok: true, me_order_id: cartData.id });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao enviar para ME: ' + e.message });
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
