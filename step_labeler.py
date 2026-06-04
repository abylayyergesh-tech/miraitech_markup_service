"""
Interactive Step/Contact Labeling Tool for Jupyter Notebooks.
Supports separate labeling for left and right foot.
Supports sequential labeling via StepLabelingSession.

Each click marks a single ground-contact point (Target=1).

Usage (single):
    from step_labeler import StepLabeler
    labeler = StepLabeler(data)
    labeler.show()

Usage (loop):
    from step_labeler import StepLabelingSession
    session = StepLabelingSession(session_ids, get_data_fn)
    # -> labels each session one by one, saves to all_step_labeled.csv at the end
    # -> access results via session.results after all done
"""
import time
import numpy as np
import pandas as pd
import plotly.graph_objects as go
import ipywidgets as widgets
from IPython.display import display, clear_output

LEFT_COLOR = 'rgba(31,119,180,0.7)'
RIGHT_COLOR = 'rgba(255,127,14,0.7)'
MARKER_SIZE = 12

ZONE_FILL_COLORS = [
    'rgba(44,160,44,0.18)',
    'rgba(148,103,189,0.18)',
    'rgba(214,39,40,0.18)',
    'rgba(140,86,75,0.18)',
    'rgba(23,190,207,0.18)',
]
ZONE_LINE_COLORS = [
    'rgba(44,160,44,0.85)',
    'rgba(148,103,189,0.85)',
    'rgba(214,39,40,0.85)',
    'rgba(140,86,75,0.85)',
    'rgba(23,190,207,0.85)',
]

DEFAULT_COL = 'magnitude'
SIGNAL_OPTIONS = ['Sensor_1', 'Sensor_2', 'Sensor_3', 'Sensor_4', 'AcX', 'AcY', 'AcZ', 'total','magnitude']
TOTAL_SENSOR_COLS = ['Sensor_1', 'Sensor_2', 'Sensor_3', 'Sensor_4']


def _signal_y_array(df: pd.DataFrame, col: str) -> np.ndarray:
    """Y values for the chart: real columns or ``total`` = sum(Sensor_1..4)."""
    if col != 'total':
        return df[col].values.astype(np.float64)
    parts = [c for c in TOTAL_SENSOR_COLS if c in df.columns]
    if not parts:
        return np.zeros(len(df), dtype=np.float64)
    return df[parts].sum(axis=1).values.astype(np.float64)


class StepLabeler:
    def __init__(self, data, title=None, window=0, timeline_data=None):
        """
        Parameters
        ----------
        data : DataFrame with columns Name, Time, Sensor_1..4, AcZ, ...
        title : optional chart title prefix
        window : reserved for API compatibility; export uses pair intervals only
                 (see _do_export / _rebuild_visuals), not per-click bands.
        timeline_data : dict with zone labels as keys and lists of
                        {'start_time', 'end_time', 'label', ...} dicts as values.
                        Zones are displayed as coloured background bands on the chart.
        """
        df = pd.DataFrame(data) if not isinstance(data, pd.DataFrame) else data
        self.left_foot = df[df['Name'] == 'ESP32_Sensor_1'].sort_values('Time').reset_index(drop=True)
        self.right_foot = df[df['Name'] == 'ESP32_Sensor_2'].sort_values('Time').reset_index(drop=True)
        self.left_foot['Target'] = 0
        self.right_foot['Target'] = 0

        self._left_time = self.left_foot['Time'].values.astype(np.float64)
        self._right_time = self.right_foot['Time'].values.astype(np.float64)

        self.left_contacts = []
        self.right_contacts = []
        self._current_foot = 'left'
        self._current_col = DEFAULT_COL
        self._title = title
        self._window = window
        self._is_done = False
        self._last_click_ts = 0.0

        self._left_rect_visible = True
        self._right_rect_visible = True
        self._timeline_data = timeline_data or {}
        self._zone_visible = True

        self._output = widgets.Output()
        self._fig = None
        self._foot_toggle = None
        self._on_done_cb = None
        self._on_skip_cb = None
        self._build()

    def _build(self):
        fig = go.FigureWidget()

        # Scattergl uses WebGL — orders of magnitude faster for large datasets
        fig.add_trace(go.Scattergl(
            x=self._left_time,
            y=self.left_foot[DEFAULT_COL].values,
            mode='lines+markers',
            name=f'Left {DEFAULT_COL}',
            line=dict(color='#1f77b4', width=1.5),
            marker=dict(size=4, opacity=0),
        ))
        fig.add_trace(go.Scattergl(
            x=self._right_time,
            y=self.right_foot[DEFAULT_COL].values,
            mode='lines+markers',
            name=f'Right {DEFAULT_COL}',
            line=dict(color='#ff7f0e', width=1.5),
            marker=dict(size=4, opacity=0),
        ))

        fig.add_trace(go.Scattergl(
            x=np.array([], dtype=np.float64),
            y=np.array([], dtype=np.float64),
            mode='markers',
            name='Left contacts',
            marker=dict(size=MARKER_SIZE, color='#1f77b4', symbol='x'),
            showlegend=True,
        ))
        fig.add_trace(go.Scattergl(
            x=np.array([], dtype=np.float64),
            y=np.array([], dtype=np.float64),
            mode='markers',
            name='Right contacts',
            marker=dict(size=MARKER_SIZE, color='#ff7f0e', symbol='x'),
            showlegend=True,
        ))

        chart_title = 'Step Labeling: select foot, click contact points'
        if self._title:
            chart_title = f'{self._title} | {chart_title}'

        fig.update_layout(
            title=chart_title,
            xaxis_title='Time (ms)', yaxis_title=DEFAULT_COL,
            height=650, width=1400,
            dragmode=False,
            legend=dict(orientation='h', yanchor='bottom', y=1.02, xanchor='right', x=1),
            hovermode='closest',
        )

        fig.data[0].on_click(self._on_click)
        fig.data[1].on_click(self._on_click)

        self._fig = fig

    @property
    def _contacts(self):
        return self.left_contacts if self._current_foot == 'left' else self.right_contacts

    @property
    def _foot_label(self):
        return 'LEFT' if self._current_foot == 'left' else 'RIGHT'

    def _refresh_output(self):
        with self._output:
            clear_output()
            nl, nr = len(self.left_contacts), len(self.right_contacts)
            foot = self._foot_label
            print(f"Active: {foot}  |  Left: {nl} contact(s)  |  Right: {nr} contact(s)")
            contacts = self._contacts
            if contacts:
                print(f"\n{self._foot_label} contacts:")
                for i, t in enumerate(contacts, 1):
                    print(f"  [{i}]  {t:.0f} ms")
            else:
                print(f"\nClick on the chart to mark {foot} foot contacts.")

    def _on_click(self, trace, points, state):
        if self._is_done or not points.point_inds:
            return
        now = time.time()
        if now - self._last_click_ts < 0.3:
            return
        self._last_click_ts = now

        t = float(trace.x[points.point_inds[0]])
        self._contacts.append(t)

        self._rebuild_visuals()
        self._refresh_output()

    def _get_y_at_time(self, foot, times):
        """Binary search for Y values at given times — O(log n) per lookup."""
        if foot == 'left':
            time_arr = self._left_time
            df = self.left_foot
        else:
            time_arr = self._right_time
            df = self.right_foot
        col = self._current_col
        vals = _signal_y_array(df, col)
        indices = np.searchsorted(time_arr, times)
        indices = np.clip(indices, 0, len(time_arr) - 1)
        # check neighbor to get the actually closest point
        alt = np.clip(indices - 1, 0, len(time_arr) - 1)
        use_alt = np.abs(time_arr[alt] - times) < np.abs(time_arr[indices] - times)
        indices[use_alt] = alt[use_alt]
        return vals[indices]
    

    def _rebuild_visuals(self):
        """Single batch update — one websocket message instead of many.

        Contacts are consumed in click order as pairs:
          click 1 + click 2  -> rectangle 1
          click 3 + click 4  -> rectangle 2  …
        An odd (unpaired) last click shows only a pending vertical line.
        Zone bands (from timeline_data) are drawn first, below contacts.
        """
        with self._fig.batch_update():
            shapes = []
            annotations = []

            # ── Timeline zones (drawn first, below contacts) ──────────────────
            if self._zone_visible and self._timeline_data:
                for zone_idx, (zone_name, intervals) in enumerate(self._timeline_data.items()):
                    fill = ZONE_FILL_COLORS[zone_idx % len(ZONE_FILL_COLORS)]
                    line = ZONE_LINE_COLORS[zone_idx % len(ZONE_LINE_COLORS)]
                    for interval in intervals:
                        x0 = float(interval['start_time'])
                        x1 = float(interval['end_time'])
                        shapes.append(dict(
                            type='rect', x0=x0, x1=x1, y0=0, y1=1, yref='y domain',
                            fillcolor=fill,
                            line=dict(color=line, width=1.5),
                            layer='below',
                        ))
                        annotations.append(dict(
                            x=(x0 + x1) / 2,
                            y=0.97,
                            xref='x',
                            yref='paper',
                            text=f'<b>{zone_name}</b>',
                            showarrow=False,
                            font=dict(size=11, color=line),
                            bgcolor='rgba(255,255,255,0.75)',
                            bordercolor=line,
                            borderwidth=1,
                            borderpad=3,
                        ))

            self._fig.layout.annotations = annotations

            for contacts, color, visible in (
                (self.left_contacts, LEFT_COLOR, self._left_rect_visible),
                (self.right_contacts, RIGHT_COLOR, self._right_rect_visible),
            ):
                if not visible:
                    continue
                # complete pairs -> filled rectangles with border lines
                for i in range(0, len(contacts) - 1, 2):
                    t0, t1 = contacts[i], contacts[i + 1]
                    x0, x1 = min(t0, t1), max(t0, t1)
                    shapes.append(dict(
                        type='rect', x0=x0, x1=x1, y0=0, y1=1, yref='y domain',
                        fillcolor=color,
                        line=dict(color=color, width=1.5),
                        layer='below',
                    ))
                # unpaired last click -> pending dotted vertical line
                if len(contacts) % 2 == 1:
                    t = contacts[-1]
                    shapes.append(dict(
                        type='line', x0=t, x1=t, y0=0, y1=1, yref='y domain',
                        line=dict(color=color, width=1.5, dash='dot'),
                        layer='below',
                    ))

            self._fig.layout.shapes = shapes

            if self.left_contacts:
                xs = np.array(self.left_contacts, dtype=np.float64)
                self._fig.data[2].x = xs
                self._fig.data[2].y = self._get_y_at_time('left', xs)
            else:
                self._fig.data[2].x = np.array([], dtype=np.float64)
                self._fig.data[2].y = np.array([], dtype=np.float64)

            if self.right_contacts:
                xs = np.array(self.right_contacts, dtype=np.float64)
                self._fig.data[3].x = xs
                self._fig.data[3].y = self._get_y_at_time('right', xs)
            else:
                self._fig.data[3].x = np.array([], dtype=np.float64)
                self._fig.data[3].y = np.array([], dtype=np.float64)  


    def _do_export(self):
        """Set Target=1 on all rows whose Time lies inside each filled pair
        interval [min(t0,t1), max(t0,t1)], same bounds as _rebuild_visuals.
        Odd unpaired trailing clicks do not export a span."""
        self.left_foot['Target'] = 0
        self.right_foot['Target'] = 0
        for contacts, time_arr, foot_df in (
            (self.left_contacts, self._left_time, self.left_foot),
            (self.right_contacts, self._right_time, self.right_foot),
        ):
            for i in range(0, len(contacts) - 1, 2):
                t0, t1 = contacts[i], contacts[i + 1]
                x0, x1 = min(t0, t1), max(t0, t1)
                mask = (time_arr >= x0) & (time_arr <= x1)
                foot_df.loc[mask, 'Target'] = 1

    def show(self, on_done=None, on_skip=None):
        self._on_done_cb = on_done
        self._on_skip_cb = on_skip

        self._foot_toggle = widgets.ToggleButtons(
            options=[('Left foot', 'left'), ('Right foot', 'right')],
            value='left',
            button_style='info',
            layout=widgets.Layout(height='36px'),
        )

        signal_dd = widgets.Dropdown(
            options=SIGNAL_OPTIONS,
            value=DEFAULT_COL, description='Signal:',
            layout=widgets.Layout(width='180px'),
        )
        undo_btn = widgets.Button(description='Undo', button_style='warning',
                                  layout=widgets.Layout(width='80px', height='36px'))
        clear_btn = widgets.Button(description='Clear Foot', button_style='danger',
                                   layout=widgets.Layout(width='110px', height='36px'))
        clear_all_btn = widgets.Button(description='Clear All', button_style='danger',
                                       layout=widgets.Layout(width='90px', height='36px'))

        show_done = on_done is not None or on_skip is not None

        left_rect_cb = widgets.Checkbox(
            value=True, description='Left rects',
            style={'description_width': 'initial'},
            layout=widgets.Layout(width='110px', height='36px'),
        )
        right_rect_cb = widgets.Checkbox(
            value=True, description='Right rects',
            style={'description_width': 'initial'},
            layout=widgets.Layout(width='115px', height='36px'),
        )
        zone_cb = widgets.Checkbox(
            value=True, description='Zones',
            style={'description_width': 'initial'},
            layout=widgets.Layout(width='90px', height='36px'),
        )

        def on_foot_change(change):
            self._current_foot = change['new']
            self._refresh_output()
        self._foot_toggle.observe(on_foot_change, names='value')

        def on_signal(change):
            col = change['new']
            self._current_col = col
            ylabel = 'total (Σ Sensor_1..4)' if col == 'total' else col
            with self._fig.batch_update():
                self._fig.data[0].y = _signal_y_array(self.left_foot, col)
                self._fig.data[1].y = _signal_y_array(self.right_foot, col)
                self._fig.data[0].name = f'Left {col}'
                self._fig.data[1].name = f'Right {col}'
                self._fig.layout.yaxis.title.text = ylabel
            self._rebuild_visuals()
        signal_dd.observe(on_signal, names='value')

        def on_undo(_):
            contacts = self._contacts
            if contacts:
                contacts.pop()
                self._rebuild_visuals()
            self._refresh_output()

        def on_clear(_):
            self._contacts.clear()
            self._rebuild_visuals()
            self._refresh_output()

        def on_clear_all(_):
            self.left_contacts.clear()
            self.right_contacts.clear()
            self._rebuild_visuals()
            self._refresh_output()

        undo_btn.on_click(on_undo)
        clear_btn.on_click(on_clear)
        clear_all_btn.on_click(on_clear_all)

        def on_left_rect_cb(change):
            self._left_rect_visible = change['new']
            self._rebuild_visuals()

        def on_right_rect_cb(change):
            self._right_rect_visible = change['new']
            self._rebuild_visuals()

        def on_zone_cb(change):
            self._zone_visible = change['new']
            self._rebuild_visuals()

        left_rect_cb.observe(on_left_rect_cb, names='value')
        right_rect_cb.observe(on_right_rect_cb, names='value')
        zone_cb.observe(on_zone_cb, names='value')

        display(widgets.HTML(
            '<div style="background:#f0fff4;padding:10px;border-radius:6px;margin-bottom:8px">'
            '<b>How to label:</b> '
            '1) Select foot (<span style="color:#1f77b4"><b>Left</b></span> / '
            '<span style="color:#ff7f0e"><b>Right</b></span>) -> '
            '2) Click on <b>ground contact</b> point -> '
            '3) Repeat -> '
            + (' 4) <b>Done / Next</b> to save and move on.' if show_done else
               ' 4) Use get_labeled_data() to retrieve.')
            + '<br><span style="color:#1f77b4">Blue = Left</span> | '
            '<span style="color:#ff7f0e">Orange = Right</span></div>'
        ))
        toolbar_items = [
            self._foot_toggle, signal_dd, undo_btn,
            clear_btn, clear_all_btn, left_rect_cb, right_rect_cb,
        ]
        if self._timeline_data:
            toolbar_items.append(zone_cb)
        display(widgets.HBox(toolbar_items))

        if show_done:
            done_btn = widgets.Button(
                description='Done / Next >>', button_style='success',
                layout=widgets.Layout(width='160px', height='42px'),
            )
            skip_btn = widgets.Button(
                description='Skip Session', button_style='warning',
                layout=widgets.Layout(width='140px', height='42px'),
            )

            def _handle_done(_):
                self._do_export()
                self._is_done = True
                n_l = int(self.left_foot['Target'].sum())
                n_r = int(self.right_foot['Target'].sum())
                with self._output:
                    clear_output()
                    print(f"Exported: Left {len(self.left_contacts)} contacts ({n_l} pts), "
                          f"Right {len(self.right_contacts)} contacts ({n_r} pts)")
                self._fig.update_layout(height=200)
                if self._on_done_cb:
                    self._on_done_cb()

            def _handle_skip(_):
                self._is_done = True
                with self._output:
                    clear_output()
                    print("Session skipped.")
                self._fig.update_layout(height=200)
                if self._on_skip_cb:
                    self._on_skip_cb()

            done_btn.on_click(_handle_done)
            skip_btn.on_click(_handle_skip)
            display(widgets.HBox([done_btn, skip_btn]))

        display(self._fig)
        display(self._output)

    def get_labeled_data(self):
        self._do_export()
        return self.left_foot.copy(), self.right_foot.copy()

    def get_combined(self):
        self._do_export()
        combined = pd.concat(
            [self.left_foot, self.right_foot], ignore_index=True
        ).sort_values('Time').reset_index(drop=True)
        return combined


class StepLabelingSession:
    """Manages sequential labeling of multiple sessions via callbacks."""

    def __init__(self, session_ids, get_data_fn, window=0):
        self.session_ids = list(session_ids)
        self.get_data = get_data_fn
        self.window = window
        self.results = []
        self._idx = 0
        self._status = widgets.Output()
        display(self._status)
        self._next()

    def _next(self):
        if self._idx >= len(self.session_ids):
            self._finish()
            return

        sid = self.session_ids[self._idx]
        with self._status:
            clear_output()
            print(f"{'='*50}")
            print(f"  Session {sid}  ({self._idx + 1}/{len(self.session_ids)})")
            print(f"{'='*50}")

        data = self.get_data(sid)
        labeler = StepLabeler(
            data,
            title=f"Session {sid} ({self._idx+1}/{len(self.session_ids)})",
            window=self.window,
        )
        labeler.show(on_done=lambda: self._on_done(labeler, sid),
                     on_skip=lambda: self._on_skip(sid))

    def _on_done(self, labeler, sid):
        combined = labeler.get_combined()
        combined['session_id'] = sid
        self.results.append(combined)
        with self._status:
            clear_output()
            print(f"Session {sid} saved. ({len(self.results)} total)")
        self._idx += 1
        self._next()

    def _on_skip(self, sid):
        with self._status:
            clear_output()
            print(f"Session {sid} skipped.")
        self._idx += 1
        self._next()

    def _finish(self):
        with self._status:
            clear_output()
            if self.results:
                all_data = pd.concat(self.results, ignore_index=True)
                all_data.to_csv('all_step_labeled.csv', index=False)
                n1 = int(all_data['Target'].sum())
                print(f"All done! {len(self.results)} session(s) labeled.")
                print(f"Total: {len(all_data)} rows, Target=1: {n1}")
                print(f"Saved to all_step_labeled.csv")
            else:
                print("No sessions were labeled.")

    def get_all_results(self):
        if not self.results:
            return pd.DataFrame()
        return pd.concat(self.results, ignore_index=True)
