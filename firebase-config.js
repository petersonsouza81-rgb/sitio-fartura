// Configuração da nuvem (Firebase) do Sítio Fartura.
//
// Com "null" no lugar do objeto, o app funciona só no celular, sem login.
// Os valores vêm do console do Firebase → Configurações do projeto → Seus apps → App da Web.
//
// Esses valores não são secretos (vão para qualquer navegador que abre o app):
// o que protege os dados é o login e as regras do Firestore (firestore.rules).
window.FIREBASE_CONFIG = {
  apiKey: 'AIzaSyDSI5Rf-u0BkAwCBenart-01rJVBAMPXIA',
  authDomain: 'sitio-fartura.firebaseapp.com',
  projectId: 'sitio-fartura',
  storageBucket: 'sitio-fartura.firebasestorage.app',
  messagingSenderId: '389158227805',
  appId: '1:389158227805:web:cb282f29b039c90d8e62b4',
};
