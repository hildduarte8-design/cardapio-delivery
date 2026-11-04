import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Rota de Health Check (Para manter o Render acordado via UptimeRobot)
app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'OK', 
    message: 'Servidor operando normalmente', 
    timestamp: new Date().toISOString() 
  });
});

// Rota raiz de teste
app.get('/', (req, res) => {
  res.send('API Delivery Control / SaaS rodando! 🚀');
});

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
