import { createMuiTheme } from 'material-ui/styles';
import grey from 'material-ui/colors/grey';
import indigo from 'material-ui/colors/indigo';

export default createMuiTheme({
  palette: {
    primary: grey,
    secondary: indigo,
    tonalOffset: 0.1,
  },
  overrides: {
    MuiAppBar: {
      colorPrimary: {
        backgroundColor: '#fff',
        opacity: 0.9,
      },
    },
    MuiSvgIcon: {
      root: {
        marginRight: '0 !important',
      },
    },
    MuiInputLabel: {
      formControl: {
        left: 'auto',
      },
    },
  },
});
