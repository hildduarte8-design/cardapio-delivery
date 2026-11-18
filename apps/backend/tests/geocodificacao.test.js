import test from 'node:test';
import assert from 'node:assert/strict';
import { criarServicoGeocodificacao, extrairLugar } from '../src/services/geocodificacao.js';

const TOKEN = 'pk.' + 'a'.repeat(40);
const AGORA = () => 1_000_000;

const corpoOk = {
  features: [{
    properties: {
      feature_type: 'address',
      name: 'Rua X 10',
      context: {
        street: { name: 'Rua X' },
        neighborhood: { name: 'Cidade Nova' },
        place: { name: 'Teófilo Otoni' }
      }
    }
  }]
};

function fetchFalso(corpo, { ok = true, status = 200 } = {}) {
  const f = async (url) => {
    f.chamadas.push(url);
    return { ok, status, json: async () => corpo };
  };
  f.chamadas = [];
  return f;
}

test('extrai rua, bairro e cidade da resposta da Mapbox', () => {
  assert.deepEqual(extrairLugar(corpoOk), { rua: 'Rua X', bairro: 'Cidade Nova', cidade: 'Teófilo Otoni' });
});

test('sem nome de rua devolve null (confirmação sem nome não confirma nada)', () => {
  const corpo = { features: [{ properties: { feature_type: 'place', name: 'Teófilo Otoni', context: {} } }] };
  assert.equal(extrairLugar(corpo), null);
  assert.equal(extrairLugar({ features: [] }), null);
  assert.equal(extrairLugar(null), null);
});

test('serviço consulta a Mapbox com as coordenadas e devolve o lugar', async () => {
  const f = fetchFalso(corpoOk);
  const s = criarServicoGeocodificacao({ token: TOKEN, fetchFn: f, agora: AGORA, env: {} });
  const lugar = await s.reverso(-17.894565, -41.503475);
  assert.equal(lugar.rua, 'Rua X');
  assert.equal(f.chamadas.length, 1);
  assert.ok(f.chamadas[0].includes('latitude=-17.894565'));
  assert.ok(f.chamadas[0].includes('longitude=-41.503475'));
});

test('token ausente ou inválido não chama a Mapbox', async () => {
  const f = fetchFalso(corpoOk);
  const s = criarServicoGeocodificacao({ token: 'qualquer-coisa', fetchFn: f, agora: AGORA, env: {} });
  assert.equal(await s.reverso(-17.9, -41.5), null);
  assert.equal(f.chamadas.length, 0);
});

test('falha HTTP ou de rede vira null e o token nunca aparece nos logs', async () => {
  const logs = [];
  const log = { warn: (m) => logs.push(String(m)) };
  const s1 = criarServicoGeocodificacao({ token: TOKEN, fetchFn: fetchFalso({}, { ok: false, status: 401 }), agora: AGORA, log, env: {} });
  assert.equal(await s1.reverso(-17.9, -41.5), null);
  const fRede = async () => { throw new Error('falhou ' + TOKEN); };
  const s2 = criarServicoGeocodificacao({ token: TOKEN, fetchFn: fRede, agora: AGORA, log, env: {} });
  assert.equal(await s2.reverso(-17.9, -41.5), null);
  assert.ok(logs.length >= 2);
  assert.ok(!logs.join(' ').includes(TOKEN));
});

test('orçamento próprio esgotado: não chama a Mapbox', async () => {
  const f = fetchFalso(corpoOk);
  const s = criarServicoGeocodificacao({ token: TOKEN, fetchFn: f, agora: AGORA, env: { GEOCODE_MAX_CHAMADAS_MIN: '2' } });
  assert.ok(await s.reverso(-17.9, -41.5));
  assert.ok(await s.reverso(-17.9, -41.5));
  assert.equal(await s.reverso(-17.9, -41.5), null);
  assert.equal(f.chamadas.length, 2);
});

test('coordenadas inválidas não chamam a Mapbox', async () => {
  const f = fetchFalso(corpoOk);
  const s = criarServicoGeocodificacao({ token: TOKEN, fetchFn: f, agora: AGORA, env: {} });
  assert.equal(await s.reverso('abc', -41.5), null);
  assert.equal(await s.reverso(95, -41.5), null);
  assert.equal(f.chamadas.length, 0);
});
