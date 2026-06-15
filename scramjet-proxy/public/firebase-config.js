const firebaseConfig = {
  apiKey: "AIzaSyB8T62wigP7Jly-6gm7XKAjC8e4nNZF-6U",
  authDomain: "classroom-chat-aad27.firebaseapp.com",
  databaseURL: "https://classroom-chat-aad27-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "classroom-chat-aad27",
  storageBucket: "classroom-chat-aad27.firebasestorage.app",
  messagingSenderId: "683337480899",
  appId: "1:683337480899:web:424624debcc5d23d2b8076",
  measurementId: "G-47NEV08S3Q"
};

try {
  if (typeof firebase !== "undefined" && !firebase.apps.length) {
    firebase.initializeApp(firebaseConfig);
    console.log("Firebase initialized OK");
  }
  if (typeof firebase !== "undefined") {
    window.kHubFirebaseDb = firebase.database();
    console.log("Firebase DB ready");
  } else {
    window.kHubFirebaseDb = null;
    console.error("Firebase SDK not loaded");
  }
} catch (error) {
  window.kHubFirebaseDb = null;
  console.error("Firebase setup failed:", error);
}
