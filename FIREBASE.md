# Ligar a nuvem (Firebase) do Sítio Fartura

> **Situação:** já configurado em 07/11/2026 no projeto `sitio-fartura` (conta Google `cpsitiofartura@gmail.com`).
> Este passo a passo fica de referência, caso seja preciso refazer.

Com a nuvem ligada, tudo o que for lançado nos celulares vai sozinho para a internet:

- os dois celulares (pai e filho) veem os mesmos dados;
- se um celular quebrar ou for trocado, é só entrar com o e-mail e a senha, que tudo volta;
- sem sinal no curral o app funciona normal e envia quando a internet voltar.

É **grátis**: o uso de um sítio fica muito abaixo do limite gratuito do Firebase.
Faça isso **uma vez só**, de preferência com a **conta Google do dono do sítio** (assim os dados são dele).

## 1. Criar o projeto

1. Entre em **https://console.firebase.google.com** com a conta Google do dono do sítio.
2. Clique em **Criar um projeto** (ou "Adicionar projeto").
3. Nome: `sitio-fartura`. Continue.
4. **Google Analytics:** desative. Clique em **Criar projeto** e espere terminar.

## 2. Ligar o login com e-mail e senha

1. No menu da esquerda: **Criação → Authentication → Vamos começar**.
2. Em **Método de login**, escolha **E-mail/senha**, ative a primeira opção e **Salve**.
3. Vá na aba **Usuários → Adicionar usuário** e crie o login do app.

   No Sítio Fartura, pai e filho usam **o mesmo login** (o Gmail do sítio, `cpsitiofartura@gmail.com`),
   nos dois celulares ao mesmo tempo. Se um dia quiserem logins separados, é só criar outro usuário aqui
   e acrescentar o e-mail nas Regras (passo 3).

## 3. Criar o banco de dados

1. No menu da esquerda: **Criação → Firestore Database → Criar banco de dados**.
2. Local: **southamerica-east1 (São Paulo)**.
3. Escolha **Iniciar no modo de produção** e clique em **Criar**.
4. Abra a aba **Regras**, apague o que estiver lá e cole o conteúdo do arquivo
   [`firestore.rules`](firestore.rules) (já está com o e-mail do sítio). Clique em **Publicar**.

## 4. Pegar a configuração do app

1. Clique na engrenagem ⚙️ ao lado de "Visão geral do projeto" → **Configurações do projeto**.
2. Em **Seus apps**, clique no ícone **Web** (`</>`).
3. Apelido: `Sítio Fartura`. **Não** marque o Firebase Hosting. Clique em **Registrar app**.
4. Vai aparecer um bloco assim:

   ```js
   const firebaseConfig = {
     apiKey: "...",
     authDomain: "sitio-fartura-xxxx.firebaseapp.com",
     projectId: "sitio-fartura-xxxx",
     storageBucket: "...",
     messagingSenderId: "...",
     appId: "..."
   };
   ```

   Copie esse bloco e cole no arquivo [`firebase-config.js`](firebase-config.js), no lugar do `null`:

   ```js
   window.FIREBASE_CONFIG = {
     apiKey: "...",
     ...
   };
   ```

   Esses valores **não são secretos**: o que protege os dados é o login e as regras do passo 3.

5. Envie a alteração para o GitHub. Em poucos minutos o app publicado passa a pedir login.

## 5. Primeiro uso em cada celular

1. Abra o app (com internet) e entre com o e-mail e a senha.
2. Se o celular já tinha animais lançados antes da nuvem, eles sobem sozinhos.
3. Pronto: daqui em diante o app abre direto, mesmo sem sinal.

No topo do app aparece a situação da nuvem: ☁️ tudo salvo, ⏳ enviando, 📴 sem internet
(os lançamentos ficam guardados e sobem depois), ⚠️ algum problema (toque para ver).

## Perguntas comuns

- **Esqueci a senha:** na tela de entrada, toque em "Esqueci a senha". Chega um e-mail para criar outra.
- **Dar acesso a mais alguém:** crie o login em Authentication → Usuários e acrescente o e-mail
  na lista das Regras do Firestore.
- **Tirar o acesso de alguém:** apague o usuário em Authentication → Usuários e tire o e-mail das Regras.
- **Ver ou baixar os dados no computador:** abra o app no navegador do computador, entre com um
  dos logins e use Mais → Planilhas ou Backup.
