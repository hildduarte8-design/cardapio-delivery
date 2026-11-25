/* ===== Frete por distância (GPS opcional) =====
   Carregar DEPOIS do vitrine-adicionais.js.
   Só aparece se a loja tiver frete_por_distancia ligado.
   Se o GPS ou a cotação falharem, vale a taxa do bairro (sem travar o pedido). */
(function () {
  let cot = null;     // { taxa, km, estimado, requer, lat, lon }
  let coords = null;  // { lat, lon } vindo do GPS
  let foraDaArea = false;
  let limiteForaDaArea = null;
  let seq = 0;        // descarta respostas antigas
  let btn = null;
  let info = null;

  const css = document.createElement('style');
  css.textContent = `
    #gps-box{margin:10px 0 14px}
    #btn-gps{width:100%;height:44px;border-radius:999px;border:1px solid #E4DCCB;background:#fff;font-weight:800;font-size:15px}
    #btn-gps:disabled{opacity:.6}
    #gps-info{font-size:13px;color:var(--suave);margin:6px 2px 0}
    #gps-info:empty{display:none}
    body.retirada #gps-box{display:none}
        #gps-confirma{margin:8px 0 0;padding:12px;border:1px solid #E4DCCB;border-radius:14px;background:#fff}
    #gps-confirma p{margin:0 0 10px;font-size:14px;font-weight:700}
    #gps-confirma button{height:40px;border-radius:999px;padding:0 16px;font-weight:800;font-size:14px;margin-right:8px;border:1px solid #E4DCCB;background:#fff}
    #gps-confirma .gps-sim{border-color:#111;background:#111;color:#fff}
  `;
  document.head.appendChild(css);

  function setInfo(txt) {
    if (info) info.textContent = txt || '';
  }

  function textoBotao() {
    return cot ? 'Atualizar minha localização' : 'Usar minha localização';
  }

  function estaBloqueado() {
    return foraDaArea && (typeof modoEntrega === 'undefined' || modoEntrega === 'entrega');
  }

  function mensagemForaDaArea() {
    const limite = Number(limiteForaDaArea);
    const ate = Number.isFinite(limite) && limite > 0
      ? ' (limite de ' + limite.toLocaleString('pt-BR') + ' km)'
      : '';
    return 'Este endereço está fora da área de entrega' + ate + '. Escolha outro endereço ou selecione retirada.';
  }

  function sincronizarBotaoPedido() {
    const botao = $('btn-enviar');
    if (!botao) return;

    if (estaBloqueado()) {
      botao.disabled = true;
      botao.dataset.bloqueioGps = '1';
      botao.textContent = 'Fora da área de entrega';
    } else if (botao.dataset.bloqueioGps === '1') {
      delete botao.dataset.bloqueioGps;
      botao.disabled = false;
      botao.textContent = 'Enviar Pedido';
    }
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
      foraDaArea = false;
      limiteForaDaArea = null;
      cot = { taxa: res.taxa, km: res.km, estimado: res.estimado, requer: res.requer, lat: res.lat, lon: res.lon };
    } else if (res.fora) {
      foraDaArea = true;
      limiteForaDaArea = res.limite ?? null;
      cot = null;
      setInfo(mensagemForaDaArea());
      avisar(mensagemForaDaArea());
    } else {
      cot = null;
      if (!foraDaArea) {
        setInfo('Não conseguimos calcular pela localização. Vale a taxa do bairro.');
      }
    }
    atualizarTaxa();
    sincronizarBotaoPedido();
  }

  /* Por cima do atualizarTaxa (que já vem embrulhado pelo vitrine-adicionais.js) */
  const taxaBase = atualizarTaxa;
  atualizarTaxa = function () {
    taxaBase();
    if (modoEntrega === 'entrega' && foraDaArea) {
      taxaAtual = 0;
      $('val-taxa').innerText = 'Fora da área';
      atualizarTotal();
      setInfo(mensagemForaDaArea());
      sincronizarBotaoPedido();
      return;
    }
    if (modoEntrega !== 'entrega' || !cot) {
      sincronizarBotaoPedido();
      return;
    }
    taxaAtual = cot.taxa;
    $('val-taxa').innerText = brl.format(cot.taxa) + (cot.requer ? ' (a confirmar)' : '');
    atualizarTotal();
    sincronizarBotaoPedido();
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

    /* ---- Confirmação do local ("Você está perto de...") ---- */
  function semAcento(t) {
    return String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
  }

  async function buscarLugar(c) {
    const ctl = new AbortController();
    const lim = setTimeout(() => ctl.abort(), 8000);
    try {
      const resp = await fetch(`${API_BACKEND_URL}/api/geocodificacao/reverso`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lat: c.lat, lon: c.lon }),
        signal: ctl.signal
      });
      const d = await resp.json().catch(() => ({}));
      if (resp.ok && d && d.sucesso && d.rua) return { rua: d.rua, bairro: d.bairro || null };
      return null;
    } catch (e) {
      return null;
    } finally {
      clearTimeout(lim);
    }
  }

  /* Só preenche o bairro se o NOME for igual ao de um bairro da lista (sem acento/maiúscula).
     O endereço só é preenchido se estiver vazio; o cursor fica no fim, esperando o número. */
  function preencherLugar(lugar) {
    const sel = $('select-bairro');
    if (lugar.bairro && sel && !sel.value) {
      const alvo = semAcento(lugar.bairro);
      for (const op of sel.options) {
        if (op.value && semAcento(op.text) === alvo) { sel.value = op.value; break; }
      }
    }
        const rua = $('cli-rua');
    if (rua && rua.value.trim() === '') {
      rua.value = lugar.rua;
      rua.dispatchEvent(new Event('input', { bubbles: true }));
      const num = $('cli-numero');
      if (num) num.focus();
    }
  }

  function perguntarLocal(lugar) {
    return new Promise((resolve) => {
      const caixa = document.createElement('div');
      caixa.id = 'gps-confirma';
      const texto = document.createElement('p');
      texto.textContent = 'Você está perto de: ' + lugar.rua + (lugar.bairro ? ', ' + lugar.bairro : '') + '. Está certo?';
      const sim = document.createElement('button');
      sim.type = 'button';
      sim.className = 'gps-sim';
      sim.textContent = 'Sim, está certo';
      const nao = document.createElement('button');
      nao.type = 'button';
      nao.textContent = 'Não';
      sim.addEventListener('click', () => { preencherLugar(lugar); caixa.remove(); resolve(true); });
      nao.addEventListener('click', () => {
        caixa.remove();
        const s = $('select-bairro');
        if (s) s.focus();
        resolve(false);
      });
      caixa.append(texto, sim, nao);
      $('gps-box').appendChild(caixa);
    });
  }
   
  function montarBotao() {
    const slot = $('gps-slot');
    const meta = slot ? null : $('select-bairro').closest('.bloco').querySelector('.meta');
    if (!slot && !meta) return;
    const box = document.createElement('div');
    box.id = 'gps-box';
    box.innerHTML = '<button type="button" id="btn-gps">Usar minha localização</button><p id="gps-info"></p>';
    if (slot) slot.appendChild(box); else meta.after(box);
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
                    btn.textContent = 'Buscando seu endereço...';
          const lugar = await buscarLugar(coords);
          if (!lugar) {
            coords = null;
            cot = null;
            setInfo('Não conseguimos identificar o local. Escolha seu bairro; vale a taxa do bairro.');
            atualizarTaxa();
            btn.disabled = false;
            btn.textContent = textoBotao();
            return;
          }
          const confirmou = await perguntarLocal(lugar);
          if (!confirmou) {
            coords = null;
            cot = null;
            setInfo('Tudo bem! Escolha o seu bairro; vale a taxa do bairro.');
            atualizarTaxa();
            btn.disabled = false;
            btn.textContent = textoBotao();
            return;
          }
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
    bloqueado() {
      return foraDaArea;
    },
    mensagemBloqueio() {
      return mensagemForaDaArea();
    },
    sincronizarBotaoPedido,
    /* Chamar depois de um pedido enviado com sucesso */
    limpar() {
      seq++;
      cot = null;
      coords = null;
      foraDaArea = false;
      limiteForaDaArea = null;
      setInfo('');
      if (btn) { btn.disabled = false; btn.textContent = textoBotao(); }
      atualizarTaxa();
      sincronizarBotaoPedido();
    },
    /* Trata o 409 FRETE_DIVERGENTE. Devolve true se tratou. */
    async tratarErro(status, r, payload) {
      if (status === 422 && r && r.codigo === 'FORA_DA_AREA') {
        const lat = Number(payload && payload.cliente_lat);
        const lon = Number(payload && payload.cliente_lon);
        if (Number.isFinite(lat) && Number.isFinite(lon)) {
          coords = { lat, lon };
        }
        foraDaArea = true;
        limiteForaDaArea = r.detalhes && r.detalhes.limite_km;
        cot = null;
        setInfo(mensagemForaDaArea());
        atualizarTaxa();
        sincronizarBotaoPedido();
        avisar(mensagemForaDaArea());
        return true;
      }

      if (!(status === 409 && r && r.codigo === 'FRETE_DIVERGENTE')) return false;

      const antes = cot ? cot.taxa : null;
      const res = await cotar();

      if (res.ok) {
        aplicar(res);
        if (antes === null || Math.round(res.taxa * 100) !== Math.round(antes * 100)) {
          avisar('O frete foi atualizado para ' + brl.format(res.taxa) + '. Confira o total e envie o pedido novamente.');
        }
      } else if (res.fora) {
        aplicar(res);
      } else {
        cot = null;
        if (!foraDaArea) {
          setInfo('Não conseguimos confirmar o frete pela localização. Vale a taxa do bairro.');
        }
        atualizarTaxa();
      }
      return true;
    }
  };
})();
