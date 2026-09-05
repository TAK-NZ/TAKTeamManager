import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { Toaster } from 'react-hot-toast'
import App from './App.jsx'
import './index.css'
// Foreign_Partner country prefix: flag glyphs for the country picker
// (TeamFormDialog) and the Dashboard "My Country" cell. flag-icons ships a
// single global stylesheet defining the `.fi` + `.fi-<alpha2>` classes.
import 'flag-icons/css/flag-icons.min.css'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
      <Toaster position="top-right" />
    </BrowserRouter>
  </React.StrictMode>,
)