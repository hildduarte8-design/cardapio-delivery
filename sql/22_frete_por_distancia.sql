select nome, taxa, tempo_estimado
from public.bairros
where restaurante_id = 'b6175a0c-cdc3-42b8-a8e8-d4f304da8fd8' and ativo
order by nome;
