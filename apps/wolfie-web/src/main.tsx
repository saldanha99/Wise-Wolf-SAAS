import React from "react";
import ReactDOM from "react-dom/client";
import { WolfieWebApp } from "./WolfieWebApp";
import "./styles.css";

const root = document.getElementById("root");

if (!root) {
  throw new Error("Elemento raiz do Wolfie não foi encontrado.");
}

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <WolfieWebApp />
  </React.StrictMode>,
);
