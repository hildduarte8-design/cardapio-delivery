import process from 'node:process';

const FATOR_RUA_URBANO = 1.3;

export function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371; // Raio terrestre em KM
  const dLat = (lat2 - lat1) * (Math.PI / 180);
  const dLon = (lon2 - lon1) * (Math.PI / 180);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * (Math.PI / 180)) * Math.cos(lat2 * (Math.PI / 180)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const distanciaLinhaReta = R * c;
  return Number((distanciaLinhaReta * FATOR_RUA_URBANO).toFixed(2));
}

export async function calcularDistanciaKm(lojaLat, lojaLon, clienteLat, clienteLon, options = {}) {
  const signal = options.signal || AbortSignal.timeout(5000);
  const mapboxToken = process.env.MAPBOX_TOKEN;

  // 1. Tenta rota real via Mapbox Directions API
  if (mapboxToken) {
    try {
      const url = `https://api.mapbox.com/directions/v5/mapbox/driving/${lojaLon},${lojaLat};${clienteLon},${clienteLat}?overview=false&access_token=${mapboxToken}`;
      const res = await fetch(url, { signal });
      if (res.ok) {
        const data = await res.json();
        if (data.routes && data.routes.length > 0) {
          const metros = data.routes[0].distance;
          return Number((metros / 1000).toFixed(2));
        }
      }
    } catch (err) {
      console.warn('[FRETE] Fallback do Mapbox ativado:', err.message);
    }
  }

  // 2. Tenta servidor público OSRM com timeout rigoroso de 3s
  try {
    const osrmUrl = `https://router.project-osrm.org/route/v1/driving/${lojaLon},${lojaLat};${clienteLon},${clienteLat}?overview=false`;
    const resOsrm = await fetch(osrmUrl, { signal: AbortSignal.timeout(3000) });
    if (resOsrm.ok) {
      const dataOsrm = await resOsrm.json();
      if (dataOsrm.routes && dataOsrm.routes.length > 0) {
        return Number((dataOsrm.routes[0].distance / 1000).toFixed(2));
      }
    }
  } catch (err) {
    console.warn('[FRETE] Fallback do OSRM ativado:', err.message);
  }

  // 3. Fallback de emergência via Haversine com fator de correção
  return haversineKm(lojaLat, lojaLon, clienteLat, clienteLon);
}

export async function calcularFrete({ restaurante, clienteLat, clienteLon, bairroTaxa }) {
  if (clienteLat !== undefined && clienteLon !== undefined && restaurante.loja_lat && restaurante.loja_lon) {
    const distanciaKm = await calcularDistanciaKm(
      restaurante.loja_lat,
      restaurante.loja_lon,
      clienteLat,
      clienteLon
    );

    if (restaurante.raio_max_km > 0 && distanciaKm > restaurante.raio_max_km) {
      return { erro: `Distância (${distanciaKm}km) excede o raio máximo permitido de ${restaurante.raio_max_km}km.` };
    }

    const taxa = Number(restaurante.taxa_base) + (distanciaKm * Number(restaurante.valor_km));
    return {
      tipo: 'gps',
      distancia_km: distanciaKm,
      taxa: Number(taxa.toFixed(2))
    };
  }

  if (bairroTaxa !== undefined && bairroTaxa !== null) {
    return {
      tipo: 'bairro',
      distancia_km: null,
      taxa: Number(Number(bairroTaxa).toFixed(2))
    };
  }

  return { erro: 'Não foi possível determinar o método de frete.' };
}
