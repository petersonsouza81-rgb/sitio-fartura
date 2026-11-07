# Sítio Fartura — controle de animais

![Logo do Sítio Fartura](icones/logo.jpg)

Controle de ovinos, caprinos, bovinos e equinos do Sítio Fartura.

**Abrir o app:** https://petersonsouza81-rgb.github.io/sitio-fartura/

App web para usar no celular, no curral, na hora de vacinar. Não precisa de internet
depois de aberto a primeira vez, e não precisa de servidor: é só HTML, CSS e JavaScript.

## O que ele faz

- **Cadastro de animais**: brinco, espécie (ovino, caprino, bovino ou equino), sexo, marca/cor do brinco,
  nascimento, peso ao nascer, mãe e situação (ativo, morto, abatido, vendido).
  Macho pode ser marcado como **reprodutor**.
  A categoria é calculada sozinha pela espécie, sexo e idade:

  | Espécie | Fêmea | Macho | Filhote (fêmea/macho) | Filhote até |
  |---|---|---|---|---|
  | Ovino | Ovelha | Carneiro | Cordeira / Cordeiro | 180 dias |
  | Caprino | Cabra | Cabrito | Cabritinha / Cabritinho | 180 dias |
  | Bovino | Vaca | Boi | Bezerra / Bezerro | 365 dias |
  | Equino | Égua | Cavalo | Potra / Potro | 365 dias |

  Os dias de filhote podem ser mudados em *Mais*.
- **Nascimento**: digita o brinco da mãe, toca nela, marca o sexo, data e peso. O filhote
  pode ficar sem brinco: ele aparece como “s/ brinco (mãe #12)”. Gêmeos: é só salvar o
  segundo em seguida.
- **Saída do rebanho**: na página do animal, os botões **Morte**, **Abate** e **Venda**.
  Morte pede a data, a causa (opcional) e até 2 fotos. Venda pede comprador, peso e valor
  por kg, e calcula o valor total na hora. Abate pede o peso do animal.
  O animal sai das contagens e da vacinação, mas o histórico dele continua na ficha.
  Se marcar errado, dá para desfazer.
- **Foto do animal** (opcional): tirar na hora ou escolher da galeria. A foto é diminuída
  automaticamente (~60 KB) e aparece nas listas, o que ajuda a achar o animal certo
  quando o brinco se repete.
- **Vacinação animal por animal**:
  1. A tela **Vacinar** já abre com a lista de animais e a data de hoje (dá para mudar a data).
  2. Escolhe o animal: toca nele na lista ou digita o número do brinco para achar mais rápido.
     Dá para filtrar por espécie e pelas abas Todos / Faltam / Feitos.
  3. Marca o que **aquele animal** recebeu (vermífugo, vitamina, antibióticos…), e se quiser o peso e uma observação.
     Aparece também o que ele recebeu da última vez, e o botão **Igual ao anterior** para repetir o que o animal anterior recebeu.
  4. Se tiver dois animais com o mesmo número, aparecem os dois (com foto, espécie, sexo e marca) e você toca no certo.
  5. Filhotes sem brinco aparecem quando você digita o brinco da mãe.
  6. A aba **Faltam** mostra quem ainda não foi lançado; **Feitos** mostra quem já foi e o que recebeu.
  7. Animal que não estava cadastrado pode ser cadastrado ali mesmo.
- **Histórico**: cada vacinação mostra quantos animais receberam cada produto, quem ficou de fora e o peso médio.
- **Fichas (relatório do animal)**: escolhe o animal e vê a ficha completa: foto, identificação,
  resumo sanitário (última vez que recebeu cada produto e quantas vezes), pesagens com ganho de peso,
  partos e filhotes (fêmeas) e o histórico completo. Dá para **imprimir / salvar em PDF** ou
  **mandar como texto** pelo WhatsApp.
- **Backup e planilhas**: exporta um arquivo `.json` (backup completo) e planilhas `.csv`
  que abrem no Excel.

## Brincos com o mesmo número

Cada animal tem um código interno único, então o número do brinco pode repetir.
Ovelha 12 e cabra 12 convivem sem aviso. Se repetir dentro da mesma espécie, o app
avisa e sugere preencher **Marca / cor do brinco** para diferenciar na hora de tocar.

## Onde ficam os dados

**Com a nuvem ligada (recomendado):** tudo vai sozinho para o Firebase (Google), na conta do
dono do sítio. Os dois celulares ficam iguais, funcionam sem sinal e, se um celular for perdido,
é só entrar de novo com o e-mail e a senha. Para ligar, siga o passo a passo em [FIREBASE.md](FIREBASE.md).

**Sem a nuvem:** os dados ficam só no celular (armazenamento do navegador; as fotos no IndexedDB). Então:

- Faça **backup** depois de cada vacinação (*Mais → Enviar backup*). Dá para mandar pelo WhatsApp.
- Se duas pessoas lançarem em celulares diferentes, uma exporta e a outra **importa**:
  o app junta os dois, sem apagar nada. Se o mesmo registro foi alterado nos dois, fica a alteração mais recente.
- Limpar os dados do navegador apaga o banco. O backup resolve isso.

## Publicar no GitHub Pages

1. Crie um repositório no GitHub e envie estes arquivos para ele.
2. No repositório: **Settings → Pages → Branch: `main` / pasta `/ (root)` → Save**.
3. Em alguns minutos o app fica em `https://SEU-USUARIO.github.io/NOME-DO-REPOSITORIO/`.
4. Abra esse endereço no celular (Chrome) e toque em **⋮ → Adicionar à tela inicial**.
   Ele vira um ícone como um aplicativo e funciona sem sinal.

Os dados **não** vão para o GitHub — o site é público, mas cada celular guarda só os seus dados.

Ao publicar uma versão nova dos arquivos, aumente `VERSAO` em `sw.js` (ex.: `rebanho-v2`).

## Testar no computador

Abra o `index.html` direto no navegador, ou rode um servidor local na pasta:

```
python -m http.server 8080
```

e acesse `http://localhost:8080`.

## Arquivos

| Arquivo | Para quê |
|---|---|
| `index.html` | Página do app |
| `style.css` | Visual (claro/escuro, pensado para tela de celular) |
| `app.js` | Telas, regras e banco de dados |
| `sw.js` | Funcionamento sem internet |
| `firebase-config.js` | Configuração da nuvem (vazia = app só no celular) |
| `firestore.rules` | Regras de segurança da nuvem (quem pode acessar) |
| `FIREBASE.md` | Passo a passo para ligar a nuvem |
| `manifest.webmanifest`, `icones/` | Instalar na tela inicial do celular (ícones feitos a partir do logo) |
| `icones/logo.jpg` | Logo do Sítio Fartura (cópia de `Logo/Conscape.jpeg`), usado no topo e nos relatórios |
