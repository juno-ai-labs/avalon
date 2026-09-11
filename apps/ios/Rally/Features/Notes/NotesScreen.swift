import SwiftUI

struct NotesScreen: View {
    @Environment(AppModel.self) private var model
    @Environment(\.rallyColors) private var colors

    var body: some View {
        NavigationStack {
            Group {
                if let note = model.currentNote {
                    NoteDetailView(note: note)
                } else {
                    noteList
                }
            }
            .background(colors.canvas.ignoresSafeArea())
            .navigationTitle(model.currentNote?.title ?? "Notes")
            .toolbar {
                if model.currentNote != nil {
                    ToolbarItem(placement: .topBarLeading) {
                        Button("Notes") { model.currentNote = nil }
                    }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("New", systemImage: "plus") {
                        Task { await model.createNote() }
                    }
                    .accessibilityLabel("New note")
                }
            }
        }
    }

    private var noteList: some View {
        List {
            if model.notes.isEmpty {
                ContentUnavailableView("No notes", systemImage: "note.text", description: Text("Capture a meeting note. Live recording stays on the Mac."))
                    .listRowBackground(colors.canvas)
            } else {
                ForEach(model.notes) { note in
                    Button {
                        Task { await model.open(note: note) }
                    } label: {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(note.title)
                                .font(RallyType.conversationTitle())
                                .foregroundStyle(colors.textPrimary)
                            if let status = note.recordingStatus {
                                Text(status)
                                    .font(RallyType.caption())
                                    .foregroundStyle(colors.textSecondary)
                            }
                        }
                    }
                    .listRowBackground(colors.canvas)
                }
            }
        }
        .scrollContentBackground(.hidden)
    }
}

struct NoteDetailView: View {
    var note: RallyNote
    @Environment(\.rallyColors) private var colors

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if let status = note.recordingStatus {
                    Label(status, systemImage: "waveform")
                        .font(RallyType.caption())
                        .foregroundStyle(colors.textSecondary)
                }
                if let live = note.liveNotes, !live.isEmpty {
                    Text("Live notes")
                        .font(RallyType.sectionHeader())
                        .foregroundStyle(colors.textPrimary)
                    Text(live)
                        .font(RallyType.body())
                        .foregroundStyle(colors.textPrimary)
                        .textSelection(.enabled)
                }
                if let manual = note.manualNotes, !manual.isEmpty {
                    Text("Your notes")
                        .font(RallyType.sectionHeader())
                        .foregroundStyle(colors.textPrimary)
                    Text(manual)
                        .font(RallyType.body())
                        .foregroundStyle(colors.textPrimary)
                        .textSelection(.enabled)
                }
                if (note.liveNotes ?? "").isEmpty && (note.manualNotes ?? "").isEmpty {
                    Text("This note has no text yet. Meeting capture and Control Tower run on the Mac.")
                        .font(RallyType.body())
                        .foregroundStyle(colors.textSecondary)
                }
            }
            .padding(20)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}
