import React from 'react';
import styled from 'styled-components';
import { Link } from 'react-router-dom';
import PropTypes from 'prop-types';

import Drawer from 'material-ui/Drawer';
import List, { ListItem, ListItemIcon, ListItemText } from 'material-ui/List';
import Typography from 'material-ui/Typography';
import Divider from 'material-ui/Divider';
import HomeIcon from 'material-ui-icons/Home';
import Timeline from 'material-ui-icons/Timeline';
import DoneAll from 'material-ui-icons/DoneAll';
import Build from 'material-ui-icons/Build';
import CodeIcon from 'material-ui-icons/Code';

import { AUTHOR_GITHUB } from '../constants/contact-info';

const ListContainer = styled.div`
  min-width: 270px;
`;

export default class NavigationPanel extends React.PureComponent {
  static propTypes = {
    isOpened: PropTypes.bool.isRequired,
    toggle: PropTypes.func.isRequired,
  };

  render() {
    const { isOpened, toggle } = this.props;
    return (
      <Drawer
        type="temporary"
        anchor="left"
        open={isOpened}
        onClose={toggle}
        ModalProps={{ keepMounted: true }}
      >
        <ListContainer>
          <List>
            <ListItem>
              <ListItemText disableTypography>
                <Typography variant="title">Gennaro Anesi</Typography>
              </ListItemText>
            </ListItem>
          </List>
          <Divider />
          <List>
            <ListItem button component={Link} to="/">
              <ListItemIcon>
                <HomeIcon />
              </ListItemIcon>
              <ListItemText primary="Home" />
            </ListItem>
            <ListItem button component={Link} to="/timeline">
              <ListItemIcon>
                <Timeline />
              </ListItemIcon>
              <ListItemText primary="Timeline" />
            </ListItem>
            <ListItem button component={Link} to="/projects">
              <ListItemIcon>
                <DoneAll />
              </ListItemIcon>
              <ListItemText primary="Projects" />
            </ListItem>
            <ListItem button component={Link} to="/technology">
              <ListItemIcon>
                <Build />
              </ListItemIcon>
              <ListItemText primary="Technologies & Tools" />
            </ListItem>
          </List>
          <Divider />
          <List>
            <ListItem
              button
              onClick={() =>
                window.open(`${AUTHOR_GITHUB}/gennaroanesi.com`, '_blank')
              }
            >
              <ListItemIcon>
                <CodeIcon />
              </ListItemIcon>
              <ListItemText primary="View code" />
            </ListItem>
          </List>
        </ListContainer>
      </Drawer>
    );
  }
}
