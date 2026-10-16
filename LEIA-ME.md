# Medição Trena — versão 5 (teste)

## Correções da versão 5
- As medidas de cima também são lidas quando a câmera entrega pouca resolução ou os dígitos ficam grudados.
- A câmera passa a pedir mais resolução.
- A calibração aprende quantos dígitos a trena mostra. Leitura com dígito faltando é descartada, nunca gravada.
- A calibração desenha um retângulo em cada medida encontrada: verde = confiável, laranja = duvidosa. Se só achar a principal, ela avisa.
- Botão **Enviar foto para análise** na calibração: manda a imagem exata que o app está vendo.
- **Calibre de novo** cada trena depois de atualizar.

## Versão 4

## Correções da versão 4
- Lê e grava **as 4 medidas**: a menor vai em destaque e as outras 3 ficam como registro. Nenhuma é mais desmarcada automaticamente; o ⚠ é só um aviso.
- A leitura espera completar todas as medidas da tela e soma os quadros da câmera até conseguir. Na tela aparece "Lendo… 3 de 4".
- A captura que você autoriza **sempre substitui** a medida do campo. Se já houver uma medida, aparece uma caixa perguntando se deseja substituir, com a atual e a nova lado a lado.
- A calibração aprende quantas medidas a sua trena mostra. **Calibre de novo** cada trena depois de atualizar.

## Versão 3

## Novo na versão 3
- **Funciona com trenas diferentes** (ex.: GLM 50 C, com dígito claro em tela colorida, e GLM 80, com dígito escuro em tela clara). As 3 medidas de cima e a principal, maior, embaixo, são identificadas pelo tamanho.
- O **décimo de milímetro** (número pequeno ao lado), o ponto, o "m", os ícones e o ângulo são ignorados.
- **Calibração por foto:** enquadre, toque em **Capturar**, digite a medida principal e toque em **Auto calibrar**. Nada some da tela enquanto você confere.
- **Medição mais rápida:** congela sozinha na primeira leitura confiável e mostra a foto da tela para conferir. Leituras duvidosas aparecem com "?".
- **Um item por página**, na ordem da planilha, com croqui, descrição completa, vidro, tratamento e linha. Use Anterior/Próximo ou os botões A1, A2… no topo.
- **Localização** já vem preenchida com o que estiver na planilha, e dá para alterar.
- **PDF gerado:** a menor medida em destaque e as outras em letra pequena logo acima, como registro.

> Ao atualizar da v2, **calibre de novo cada trena** (Trenas → Calibrar).


## Novo na versão 2: as 4 medidas de uma vez
A trena Bosch mostra na tela a última medida (grande, embaixo) e as 3 anteriores. Agora o app lê **as 4 de uma só vez**:
1. Meça os 4 pontos do vão com a trena.
2. Toque no 📷 do campo e aponte para a tela da trena. O quadro deve cobrir as medidas; pegar a tela inteira também funciona.
3. Quando duas leituras seguidas batem, o app congela o resultado e mostra as 4 medidas. A **menor** vai para o campo e as outras ficam guardadas como **registro**, embaixo do campo.
4. Medidas com mais de 50 mm de diferença da última aparecem com ⚠ e já vêm desmarcadas, porque podem ser do vão anterior. Toque numa medida para marcar ou desmarcar.
5. Toque em **Usar medidas**, ou em **Ler de novo** se algo saiu errado.

O modo antigo (uma medida por vez) continua disponível em Trenas → Calibrar → "O que ler na tela da trena".

App de celular que abre o PDF **"Relação de Itens para Medição"** do CEM, lê o visor da trena pela câmera e devolve o PDF preenchido.

## O que já faz
- Importa o PDF do CEM e lista cada esquadria (tipo, descrição, medida de projeto) com as linhas 1/1, 1/2… para medir.
- Para cada linha: Localização, Largura, Altura e, se quiser, medidas do contramarco.
- Botão 📷 abre a câmera; enquadre só o número principal da trena. O app só aceita a leitura depois que **duas leituras seguidas batem**. Meça 3 ou 4 pontos: fica a **menor**, e as outras aparecem pequenas embaixo.
- Dá para digitar a medida na mão, se preferir.
- **Trenas (📏):** um perfil por trena ou situação, com **Auto calibrar**. Você enquadra o número, digita o valor que a trena mostra e o app testa 21 ajustes de imagem até achar o que lê certo.
- **Gerar PDF preenchido:** escreve as medidas em azul nas células do próprio PDF e abre o compartilhar do Android (WhatsApp, Drive, e-mail…).
- Tudo fica salvo no celular, então dá pra fechar o app e continuar depois.

## Como colocar no celular (GitHub Pages, gratuito)
A câmera só funciona em endereço seguro (https), por isso o app precisa ficar hospedado.

1. Crie uma conta em **github.com** (se ainda não tiver).
2. Clique em **New repository** → nome: `medicao-trena` → **Public** → **Create repository**.
3. Na página do repositório: **uploading an existing file** → arraste **todos os arquivos desta pasta** (não a pasta, os arquivos) → **Commit changes**.
4. Vá em **Settings → Pages** → em *Branch* escolha `main` e `/ (root)` → **Save**.
5. Em 1–2 minutos o endereço aparece no topo da página, no formato `https://SEU-USUARIO.github.io/medicao-trena/`.
6. No Android, abra esse endereço no **Chrome** → menu ⋮ → **Instalar app** (ou "Adicionar à tela inicial").

Na 1ª vez que abrir a câmera, o app baixa o leitor (~10 MB) e por isso precisa de internet. Depois disso, ele também funciona offline.

## Para atualizar
Suba os arquivos novos no mesmo repositório (substituindo os antigos). No celular, feche e abra o app duas vezes.

## Próximo passo: instalador .apk
Quando a versão estiver aprovada, use o **pwabuilder.com**: cole o endereço do app → **Package for stores → Android** → baixe o .apk e mande para os medidores.

## Arquivos
- `index.html`: telas
- `app.js`: câmera, leitura da trena, calibração, PDF
- `parse.js`: leitura do PDF do CEM
- `sw.js`, `manifest.webmanifest`, `icon-*.png`: instalação e modo offline
