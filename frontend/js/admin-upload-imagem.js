// Upload de imagens com compressão (usado por produtos e adicionais)

const MAX_ENTRADA_MB = 15;

function nomeUnico() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

async function abrirImagem(arquivo) {
  // Corrige a rotação de fotos tiradas no celular
  if (window.createImageBitmap) {
    try {
      return await createImageBitmap(arquivo, { imageOrientation: 'from-image' });
    } catch (_) {
      /* tenta o jeito antigo abaixo */
    }
  }
  return await new Promise((resolve, reject) => {
    const url = URL.createObjectURL(arquivo);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Não foi possível abrir a imagem.'));
    };
    img.src = url;
  });
}

// Reduz a imagem e devolve um Blob JPEG
export async function comprimirImagem(arquivo, { maxLado = 900, qualidade = 0.8 } = {}) {
  if (!arquivo || !String(arquivo.type).startsWith('image/')) {
    throw new Error('Escolha um arquivo de imagem.');
  }
  if (arquivo.size > MAX_ENTRADA_MB * 1024 * 1024) {
    throw new Error(`A imagem é muito grande (máximo ${MAX_ENTRADA_MB} MB).`);
  }

  const img = await abrirImagem(arquivo);
  const largura = img.width;
  const altura = img.height;
  const escala = Math.min(1, maxLado / Math.max(largura, altura));

  const canvas = document.createElement('canvas');
  canvas.width = Math.round(largura * escala);
  canvas.height = Math.round(altura * escala);

  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff'; // fundo branco para PNG com transparência
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  if (img.close) img.close();

  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', qualidade));
  if (!blob) throw new Error('Não foi possível reduzir a imagem.');
  return blob;
}

// Comprime e envia. Devolve a URL pública da imagem.
// supabase: o cliente que o admin já usa
// pasta: 'produtos' ou 'adicionais'
export async function enviarImagem(supabase, { bucket, restauranteId, pasta, arquivo }) {
  if (!restauranteId) throw new Error('Restaurante não identificado.');

  const blob = await comprimirImagem(arquivo);
  const caminho = `${restauranteId}/${pasta}/${nomeUnico()}.jpg`;

  const { error } = await supabase.storage.from(bucket).upload(caminho, blob, {
    contentType: 'image/jpeg',
    cacheControl: '31536000',
    upsert: false,
  });
  if (error) throw new Error('Não foi possível enviar a foto. Tente de novo.');

  const { data } = supabase.storage.from(bucket).getPublicUrl(caminho);
  return data.publicUrl;
}

// Apaga a foto antiga (melhor esforço: se falhar, não atrapalha o resto)
export async function removerImagem(supabase, bucket, url) {
  try {
    const marcador = `/object/public/${bucket}/`;
    const i = String(url || '').indexOf(marcador);
    if (i === -1) return;
    const caminho = decodeURIComponent(url.slice(i + marcador.length).split('?')[0]);
    await supabase.storage.from(bucket).remove([caminho]);
  } catch (_) {
    /* ignora */
  }
}
