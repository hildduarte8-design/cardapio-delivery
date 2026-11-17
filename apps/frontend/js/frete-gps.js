/* ===== Frete por distância (GPS opcional) =====
   Carregar DEPOIS do vitrine-adicionais.js.
   Só aparece se a loja tiver frete_por_distancia ligado.
   Se o GPS ou a cotação falharem, vale a taxa do bairro (sem travar o pedido). */
(function () {
  let cot = null;     // { taxa, km, estimado, requer, lat, lon }
  let coords = null;  // { lat, lon } vindo do GPS
  let seq = 0;        // descarta respostas antigas
  let btn = null;
  let info = null;

  const css = document.createElement('style');
  css.textContent = `
    #gps-box{margin:10px 0 4px}
    #btn-gps{width:100%;height:44px;border-radius:999px;border:1px solid #E4DCCB;background:#fff;font-weight:800;font-size:15px}
    #btn-gps:disabled{opacity:.6}
    #gps-info{font-size:13px;color:var(--suave);margin:6px 2px 0}
    #gps-info:empty{display:none}
    body.retirada #gps-box{display:none}
  `;
  document.head.appendChild(css);

  function setInfo(txt) {
    if (info) info.textContent = txt || '';
  }

  function textoBotao() {
    return cot ? 'Atualizar minha localização' : 'Usar minha localização';
  }

  function lerTaxa(d) {
    const t = Number(d.taxa);
    if (Number.isFinite(t) && t >= 0) return t;
    const c = Number(d.taxa_centavos);
    return Number.isFinite(c) && c >= 0 ? c / 100 : null;
  }

  async function cotar() {
    if (!coords) return { falhou: true };
    const minha = ++seq;
    const sel = $('select-bairro');
    const corpo = {
      restaurante_id: restauranteInfo.id,
      cliente_lat: coords.lat,
      cliente_lon: coords.lon
    };
    if (sel && sel.value) corpo.bairro_id = sel.value;

    const ctl = new AbortController();
    const lim = setTimeout(() => ctl.abort(), 12000);
    try {
      const resp = await fetch(`${API_BACKEND_URL}/api/frete/cotar`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(corpo),
        signal: ctl.signal
      });
      const d = await resp.json().catch(() => ({}));
      if (minha !== seq) return { obsoleta: true };

      if (resp.ok && d && d.sucesso) {
        const taxa = lerTaxa(d);
        if (taxa === null) return { falhou: true };
        const km = Number(d.distancia_km);
        return {
          ok: true,
          taxa,
          km: Number.isFinite(km) && km > 0 ? km : null,
          estimado: d.estimado === true,
          requer: d.requer_confirmacao === true,
          lat: coords.lat,
          lon: coords.lon
        };
      }
      if (d && d.codigo === 'FORA_DA_AREA') {
        return { fora: true, limite: d.detalhes && d.detalhes.limite_km };
      }
      return { falhou: true };
    } catch (e) {
      if (minha !== seq) return { obsoleta: true };
      return { falhou: true };
    } finally {
      clearTimeout(lim);
    }
  }

  function aplicar(res) {
    if (res.obsoleta) return;
    if (res.ok) {
      cot = { taxa: res.taxa, km: res.km, estimado: res.estimado, requer: res.requer, lat: res.lat, lon: res.lon };
    } else if (res.fora) {
      cot = null;
      coords = null;
      const lim = Number(res.limite);
      const ate = Number.isFinite(lim) && lim > 0 ? ' (até ' + lim.toLocaleString('pt-BR') + ' km)' : '';
      setInfo('Pela sua localização, você está fora da área de entrega' + ate + '. Chame a loja no WhatsApp antes de enviar o pedido.');
      avisar('Pela sua localização, você está fora da área de entrega' + ate + '. Chame a loja no WhatsApp antes de enviar o pedido.');
    } else {
      cot = null;
      setInfo('Não conseguimos calcular pela localização. Vale a taxa do bairro.');
    }
    atualizarTaxa();
  }

  /* Por cima do atualizarTaxa (que já vem embrulhado pelo vitrine-adicionais.js) */
  const taxaBase = atualizarTaxa;
  atualizarTaxa = function () {
    taxaBase();
    if (modoEntrega !== 'entrega' || !cot) return;
    taxaAtual = cot.taxa;
    $('val-taxa').innerText = brl.format(cot.taxa) + (cot.requer ? ' (a confirmar)' : '');
    atualizarTotal();
    const dist = cot.km !== null
      ? cot.km.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + ' km'
      : '';
    const partes = [];
    if (dist) partes.push('Distância: ' + dist);
    if (cot.requer) partes.push('valor a confirmar com a loja');
    setInfo(partes.join(' · '));
  };

  /* Trocou o bairro com GPS ativo: cota de novo (o bairro é o plano B do servidor) */
  $('select-bairro').addEventListener('change', async () => {
    if (!coords || modoEntrega !== 'entrega') return;
    cot = null;
    aplicar(await cotar());
  });

  function montarBotao() {
    const meta = $('select-bairro').closest('.bloco').querySelector('.meta');
    if (!meta) return;
    const box = document.createElement('div');
    box.id = 'gps-box';
    box.innerHTML = '<button type="button" id="btn-gps">Usar minha localização</button><p id="gps-info"></p>';
    meta.after(box);
    btn = $('btn-gps');
    info = $('gps-info');

    btn.addEventListener('click', () => {
      if (!navigator.geolocation) {
        setInfo('Este aparelho não permite localização. Vale a taxa do bairro.');
        return;
      }
      btn.disabled = true;
      btn.textContent = 'Buscando localização...';
      navigator.geolocation.getCurrentPosition(
         async (pos) => {
          // Precisão ruim (ex.: computador, que estima pelo IP): não usa o GPS, vale o bairro.
          if (!(pos.coords.accuracy <= 300)) {
            coords = null;
            cot = null;
              setInfo('Localização imprecisa. Escolha seu bairro; vale a taxa do bairro.');
            atualizarTaxa();
            btn.disabled = false;
            btn.textContent = textoBotao();
            return;
          }
          coords = {
            lat: Number(pos.coords.latitude.toFixed(6)),
            lon: Number(pos.coords.longitude.toFixed(6))
          };
          btn.textContent = 'Calculando frete...';
          aplicar(await cotar());
          btn.disabled = false;
          btn.textContent = textoBotao();
        },
        () => {
          coords = null;
          cot = null;
          setInfo('Não foi possível usar a localização. Vale a taxa do bairro.');
          atualizarTaxa();
          btn.disabled = false;
          btn.textContent = textoBotao();
        },
                { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
      );
    });
  }

  /* Só liga se a loja tiver frete_por_distancia. restauranteInfo carrega depois, então espera. */
  const espera = setInterval(() => {
    if (typeof restauranteInfo === 'undefined' || !restauranteInfo || !restauranteInfo.id) return;
    clearInterval(espera);
    if (restauranteInfo.frete_por_distancia === true) montarBotao();
  }, 300);
  setTimeout(() => clearInterval(espera), 60000);

  window.freteGps = {
    /* Campos extras do pedido (vazio se não há cotação por GPS válida) */
    payload() {
      return cot ? { cliente_lat: cot.lat, cliente_lon: cot.lon, taxa_cotada: cot.taxa } : {};
    },
    /* Chamar depois de um pedido enviado com sucesso */
    limpar() {
      seq++;
      cot = null;
      coords = null;
      setInfo('');
      if (btn) { btn.disabled = false; btn.textContent = textoBotao(); }
    },
    /* Trata o 409 FRETE_DIVERGENTE. Devolve true se tratou. */
    async tratarErro(status, r) {
      if (!(status === 409 && r && r.codigo === 'FRETE_DIVERGENTE')) return false;
      const antes = cot ? cot.taxa : null;
      const res = await cotar();
      if (res.ok && antes !== null && Math.round(res.taxa * 100) !== Math.round(antes * 100)) {
        aplicar(res);
        avisar('O frete foi atualizado para ' + brl.format(res.taxa) + '. Confira o total e toque em Enviar Pedido para confirmar.');
      } else {
        cot = null;
        coords = null;
        setInfo('Não conseguimos confirmar o frete pela localização. Vale a taxa do bairro.');
        atualizarTaxa();
        avisar('Não conseguimos confirmar o frete pela localização. Vale a taxa do bairro: ' + brl.format(taxaAtual) + '. Confira o total e envie de novo.');
      }
      return true;
    }
  };
})();
