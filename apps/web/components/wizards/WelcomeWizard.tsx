import { toast } from "sonner";
import { useState } from "react";
import { useStore } from "@/lib/store";
import { MoneyInput } from "../MoneyInput";
import { Avatar } from "../Avatar";
import { Trash2, Plus, PartyPopper } from "lucide-react";

export function WelcomeWizard() {
  const { state, updateSettings, removeWorker, addWorker } = useStore();
  const [step, setStep] = useState(1);
  const [name, setName] = useState(state.settings.companyName);
  const [cash, setCash] = useState(state.settings.initialCash);
  const [bank, setBank] = useState(state.settings.initialBank);
  const [newWorker, setNewWorker] = useState("");

  function finish() {
    updateSettings({ companyName: name, initialCash: cash, initialBank: bank, setupComplete: true })
      .catch((e) => toast.error((e as Error)?.message || "No se pudo guardar la configuración"));
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <div className="w-full max-w-xl glass-strong rounded-3xl p-8 shadow-cash">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-primary to-accent flex items-center justify-center text-background font-black text-2xl">E</div>
          <div>
            <div className="text-xs uppercase tracking-wider text-muted-foreground">Paso {step} de 5</div>
            <div className="flex gap-1 mt-1">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className={`h-1 w-8 rounded-full ${i < step ? "bg-primary" : "bg-secondary"}`} />
              ))}
            </div>
          </div>
        </div>

        {step === 1 && (
          <>
            <h2 className="text-3xl font-black">¡Bienvenido! 👋</h2>
            <p className="text-muted-foreground mt-2">¿Cómo se llama tu empresa de domicilios?</p>
            <input autoFocus value={name} onChange={(e) => setName(e.target.value)} className="mt-6 w-full glass rounded-2xl px-5 py-4 text-2xl font-bold outline-none focus:ring-2 focus:ring-primary/40" />
            <button onClick={() => setStep(2)} className="mt-6 w-full bg-primary text-primary-foreground font-bold py-4 rounded-2xl shadow-cash">Siguiente →</button>
          </>
        )}

        {step === 2 && (
          <>
            <h2 className="text-3xl font-black">💵 Caja inicial</h2>
            <p className="text-muted-foreground mt-2">¿Con cuánto efectivo arranca la caja hoy?</p>
            <div className="mt-6"><MoneyInput value={cash} onChange={setCash} autoFocus /></div>
            <div className="flex gap-2 mt-6">
              <button onClick={() => setStep(1)} className="flex-1 bg-secondary py-4 rounded-2xl font-bold">← Atrás</button>
              <button onClick={() => setStep(3)} className="flex-[2] bg-primary text-primary-foreground font-bold py-4 rounded-2xl shadow-cash">Siguiente →</button>
            </div>
          </>
        )}

        {step === 3 && (
          <>
            <h2 className="text-3xl font-black">🏦 Banco</h2>
            <p className="text-muted-foreground mt-2">¿Cuánto hay en el banco?</p>
            <div className="mt-6"><MoneyInput value={bank} onChange={setBank} autoFocus /></div>
            <div className="flex gap-2 mt-6">
              <button onClick={() => setStep(2)} className="flex-1 bg-secondary py-4 rounded-2xl font-bold">← Atrás</button>
              <button onClick={() => setStep(4)} className="flex-[2] bg-primary text-primary-foreground font-bold py-4 rounded-2xl shadow-cash">Siguiente →</button>
            </div>
          </>
        )}

        {step === 4 && (
          <>
            <h2 className="text-3xl font-black">🛵 Tus domiciliarios</h2>
            <p className="text-muted-foreground mt-2">¿Están todos? Puedes editar después.</p>
            <div className="mt-4 max-h-64 overflow-auto space-y-1.5">
              {state.workers.filter(w => w.role === "domiciliario").map(w => (
                <div key={w.id} className="flex items-center gap-3 glass rounded-xl p-2.5">
                  <Avatar worker={w} size={32} />
                  <span className="flex-1 font-medium">{w.name}</span>
                  <button onClick={() => removeWorker(w.id)} className="p-2 text-danger hover:bg-danger-soft rounded-lg">
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              ))}
            </div>
            <div className="flex gap-2 mt-3">
              <input value={newWorker} onChange={(e) => setNewWorker(e.target.value)} placeholder="Nombre" className="flex-1 glass rounded-xl px-4 py-3 outline-none" />
              <button onClick={() => { if (newWorker.trim()) { void addWorker({ name: newWorker.trim(), role: "domiciliario", active: true }); setNewWorker(""); } }} className="bg-primary text-primary-foreground px-4 rounded-xl font-bold flex items-center gap-1">
                <Plus className="h-4 w-4" /> Agregar
              </button>
            </div>
            <div className="flex gap-2 mt-6">
              <button onClick={() => setStep(3)} className="flex-1 bg-secondary py-4 rounded-2xl font-bold">← Atrás</button>
              <button onClick={() => setStep(5)} className="flex-[2] bg-primary text-primary-foreground font-bold py-4 rounded-2xl shadow-cash">Siguiente →</button>
            </div>
          </>
        )}

        {step === 5 && (
          <div className="text-center py-6">
            <PartyPopper className="h-16 w-16 text-primary mx-auto animate-pop" />
            <h2 className="text-3xl font-black mt-4">¡Todo listo! 🎉</h2>
            <p className="text-muted-foreground mt-2">Tu caja está configurada.</p>
            <button onClick={finish} className="mt-8 w-full bg-primary text-primary-foreground font-bold py-4 rounded-2xl shadow-cash">
              Empezar a usar →
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
